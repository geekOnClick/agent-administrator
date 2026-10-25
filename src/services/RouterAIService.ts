import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BILLS_VALIDATE_SYSTEM_PROMPT,
  RECEIPT_VERIFY_ROUTERAI_SYSTEM_PROMPT,
  BILL_COLUMNS_EXTRACT_SYSTEM_PROMPT,
  BILL_CATEGORIES,
  BillCategory
} from '../llm/prompts.js';
import { config } from '../config.js';
import { DocumentMaskingService } from './DocumentMaskingService.js';
import { parseRuNumber } from './bill-totals/BillTotalsParser.js';

interface RouterAIContentPart {
  type: 'text' | 'file' | 'image_url';
  text?: string;
  file?: { filename: string; file_data: string };
  image_url?: { url: string };
}

interface RouterAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | RouterAIContentPart[];
}

interface RouterAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
      annotations?: Array<{
        type: 'file';
        file: {
          hash: string;
          name?: string;
          content: Array<RouterAIContentPart>;
        };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface RouterAIEmbedResponse {
  data: Array<{ embedding: number[] }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

/** Накопленное потребление RouterAI за время жизни процесса — основа метрики стоимости. */
export interface RouterAIUsageStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costRub: number;
}

interface ChatSession {
  messages: RouterAIMessage[];
  systemPrompt: string;
}

/**
 * true, если ошибка RouterAI — это конфигурационная проблема (невалидный ключ / кончился баланс),
 * а не недоступность сервиса: такие ошибки НЕ приводят к fallback на резервную модель.
 */
function isAuthOrTokenError(error: unknown): boolean {
  if (error instanceof Error && (error as any).isTokenError === true) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /\b(401|402)\b/.test(msg);
}

export class RouterAIService {
  private apiKey: string;
  private model: string;
  private additionalModel: string;
  private apiUrl: string;
  private embedUrl: string;
  private readonly stats: RouterAIUsageStats = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    costRub: 0
  };
  /** Сессии чата (ask/askMeters): sessionId → {messages, systemPrompt}. */
  private readonly sessions = new Map<string, ChatSession>();

  constructor() {
    this.apiKey = process.env.AIROUTER_API_KEY || '';
    this.model = process.env.AIROUTER_MODEL || 'google/gemini-3-flash';
    this.additionalModel = process.env.AIROUTER_MODEL_ADDITIONAL || '';
    this.apiUrl = process.env.ROUTERAI_API_URL || 'https://routerai.ru/api/v1/chat/completions';
    this.embedUrl = process.env.ROUTERAI_EMBED_URL || 'https://routerai.ru/api/v1/embeddings';
    if (!this.apiKey) {
      throw new Error('AIROUTER_API_KEY не задан в .env');
    }
  }

  getModelName(): string {
    return this.model;
  }

  getAdditionalModelName(): string {
    return this.additionalModel;
  }

  hasAdditionalModel(): boolean {
    return this.additionalModel.trim().length > 0;
  }

  /** Копия накопленной статистики потребления (для метрики стоимости цикла/сессии). */
  getUsageStats(): RouterAIUsageStats {
    return { ...this.stats };
  }

  private trackUsage(usage: RouterAIResponse['usage'] | RouterAIEmbedResponse['usage']): void {
    this.stats.requests += 1;
    if (!usage) return;
    const u = usage as { prompt_tokens?: number; completion_tokens?: number };
    const promptTokens = u.prompt_tokens ?? 0;
    const completionTokens = u.completion_tokens ?? 0;
    this.stats.promptTokens += promptTokens;
    this.stats.completionTokens += completionTokens;
    this.stats.costRub +=
      promptTokens * config.evals.routerAIInputRubPerToken +
      completionTokens * config.evals.routerAIOutputRubPerToken;
  }

  private toBase64(filePath: string): string {
    return fs.readFileSync(filePath).toString('base64');
  }

  private static readonly MIME_BY_EXT: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.odt': 'application/vnd.oasis.opendocument.text'
  };

  private buildFilePart(filePath: string, maskedFilename?: string): RouterAIContentPart {
    const originalFilename = path.basename(filePath);
    const filename = maskedFilename ?? originalFilename;
    const mime = RouterAIService.MIME_BY_EXT[path.extname(filePath).toLowerCase()];
    if (!mime) {
      throw new Error(`Неподдерживаемый формат файла для отправки в модель: ${originalFilename}`);
    }
    const b64 = this.toBase64(filePath);
    return {
      type: 'file',
      file: {
        filename,
        file_data: `data:${mime};base64,${b64}`
      }
    };
  }

  /**
   * Низкоуровневый POST /chat/completions к конкретной модели.
   * Бросает RouterAIError с isTokenError при 401/402 (не fallback-ятся), прочие ошибки — обычные.
   */
  private async postChat(
    model: string,
    messages: RouterAIMessage[],
    opts: { withFileParser?: boolean } = {}
  ): Promise<RouterAIResponse> {
    const body: Record<string, unknown> = { model, messages };
    if (opts.withFileParser) {
      body.plugins = [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }];
    }
    if (config.evals.maxResponseTokens > 0) {
      body.max_tokens = config.evals.maxResponseTokens;
    }

    let response: Response;
    try {
      response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        ...(config.routerAI.requestTimeoutMs > 0
          ? { signal: AbortSignal.timeout(config.routerAI.requestTimeoutMs) }
          : {})
      });
    } catch (err) {
      throw new RouterAIError(`Сетевая ошибка RouterAI: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (
        response.status === 402 ||
        errText.toLowerCase().includes('insufficient') ||
        errText.toLowerCase().includes('balance') ||
        errText.toLowerCase().includes('quota') ||
        errText.toLowerCase().includes('token')
      ) {
        const tokenError = new RouterAIError(
          `RouterAI: недостаточно токенов для запроса (${response.status}): ${errText}`
        );
        tokenError.isTokenError = true;
        throw tokenError;
      }
      if (response.status === 401) {
        const authError = new RouterAIError(`RouterAI API error 401 (невалидный ключ): ${errText}`);
        authError.isTokenError = true; // 401 — конфигурационная ошибка, не fallback
        throw authError;
      }
      throw new RouterAIError(`RouterAI API error ${response.status}: ${errText}`);
    }

    return (await response.json()) as RouterAIResponse;
  }

  /**
   * Обёртка с fallback: вызывает fn(model) на основной модели, при недоступности
   * (сеть/5xx/таймаут, но НЕ auth/токен) — повторяет на резервной модели (AIROUTER_MODEL_ADDITIONAL).
   * Если резервной нет — пробрасывает ошибку основной.
   */
  private async withFallback<T>(
    fn: (model: string) => Promise<T>,
    label: string
  ): Promise<T> {
    try {
      return await fn(this.model);
    } catch (error) {
      if (isAuthOrTokenError(error)) throw error;
      if (!this.hasAdditionalModel()) {
        if (error instanceof RouterAIError) throw error;
        throw new RouterAIError(error instanceof Error ? error.message : String(error));
      }
      const primaryMsg = error instanceof Error ? error.message : String(error);
      console.warn(`[RouterAI] Основная модель «${this.model}» недоступна (${label}): ${primaryMsg}. Переключаюсь на резервную «${this.additionalModel}».`);
      try {
        return await fn(this.additionalModel);
      } catch (fallbackError) {
        if (isAuthOrTokenError(fallbackError)) throw fallbackError;
        const fbMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new RouterAIError(
          `Обе модели RouterAI недоступны (${label}). Основная: ${primaryMsg}; резервная: ${fbMsg}`
        );
      }
    }
  }

  /**
   * Сессионный чат для режимов ask/askMeters: поддерживает историю по sessionId,
   * системный промпт, fallback на резервную модель. Возвращает sanitized ответ.
   */
  async chat(sessionId: string, message: string): Promise<string> {
    const session = this.getOrCreateSession(sessionId);
    session.messages.push({ role: 'user', content: message });

    const response = await this.withFallback(
      (model) => this.postChat(model, session.messages),
      `chat session=${sessionId}`
    );
    this.trackUsage(response.usage);
    const content = response.choices?.[0]?.message?.content ?? '';
    session.messages.push({ role: 'assistant', content });
    return sanitizeModelOutput(content);
  }

  /** Устанавливает системный промпт для сессии (пересоздаёт сессию при смене промпта). */
  async setSessionSystemPrompt(sessionId: string, systemPrompt: string): Promise<void> {
    const session = this.getOrCreateSession(sessionId);
    const normalized = systemPrompt.trim();
    session.systemPrompt = normalized;
    // Пересобираем историю: системный промпт первым, остальные сообщения (без старого system).
    const rest = session.messages.filter((m) => m.role !== 'system');
    session.messages = normalized ? [{ role: 'system', content: normalized }, ...rest] : rest;
  }

  async resetSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  private getOrCreateSession(sessionId: string): ChatSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { messages: [], systemPrompt: '' };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** Одноразовый текстовый чат с RouterAI (без истории, без файла) — с fallback. */
  async chatOnce(systemPrompt: string, message: string): Promise<string> {
    const messages: RouterAIMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message }
    ];
    const response = await this.withFallback(
      (model) => this.postChat(model, messages),
      'chatOnce'
    );
    this.trackUsage(response.usage);
    return response.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Эмбеддинги через RouterAI (OpenAI-совместимый /v1/embeddings) — для векторной базы
   * FalkorDB (режимы ask/askMeters/meters). Заменила локальную Ollama nomic-embed-text.
   */
  async embed(texts: string[]): Promise<number[][]> {
    const body = { model: config.routerAI.embedModel, input: texts };
    let response: Response;
    try {
      response = await fetch(this.embedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        ...(config.routerAI.requestTimeoutMs > 0
          ? { signal: AbortSignal.timeout(config.routerAI.requestTimeoutMs) }
          : {})
      });
    } catch (err) {
      throw new RouterAIError(`Сетевая ошибка RouterAI embeddings: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new RouterAIError(`RouterAI embeddings error ${response.status}: ${errText}`);
    }
    const data = (await response.json()) as RouterAIEmbedResponse;
    this.trackUsage(data.usage);
    return (data.data ?? []).map((d) => d.embedding);
  }

  async embedOne(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }

  /**
   * Отправляет файлы (сканы/фото) в модель для валидации категорий + извлечения суммы.
   * Возвращает только детали по файлам и ошибки — итог covered/missing/valid собирает роутер
   * (после слияния с детерминированными результатами текстовых файлов).
   */
  async validateBillCategoriesByModel(filePaths: string[]): Promise<ModelBatchValidationResult> {
    const masker = new DocumentMaskingService(filePaths);
    const contentParts: RouterAIContentPart[] = [];

    for (const filePath of filePaths) {
      try {
        const maskedFilename = masker.getMaskedFilename(filePath);
        const part = this.buildFilePart(filePath, maskedFilename);
        contentParts.push(part);
      } catch (err) {
        console.error(`[validate] Пропускаю файл ${path.basename(filePath)}:`, err);
      }
    }

    if (contentParts.length === 0) {
      return { details: [], errors: ['Не удалось подготовить ни одного файла для валидации'] };
    }

    contentParts.unshift({
      type: 'text',
      text: `Проанализируй приложенные документы (${filePaths.length} шт.). Определи категорию каждого счёта и проверь, есть ли сумма к оплате.`
    });

    console.log(`[masking] Отправка ${filePaths.length} файл(ов) в LLM под псевдонимами:`);
    for (const [masked, original] of masker.getMaskMap()) {
      console.log(`  ${masked}  ← ${original}`);
    }

    const messages: RouterAIMessage[] = [
      { role: 'system', content: BILLS_VALIDATE_SYSTEM_PROMPT },
      { role: 'user', content: contentParts }
    ];

    try {
      const response = await this.withFallback(
        (model) => this.postChat(model, messages, { withFileParser: true }),
        'валидация категорий (сканы)'
      );
      this.trackUsage(response.usage);
      const rawReply = response.choices?.[0]?.message?.content || '{}';
      const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { details: [], errors: [`Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}`] };
      }
      const parsed = JSON.parse(jsonMatch[0]) as BillValidationResult;
      const unmasked = masker.unmaskBillValidationResult(parsed);
      return { details: unmasked.details ?? [], errors: parsed.errors ?? [] };
    } catch (error) {
      if (isAuthOrTokenError(error)) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      return { details: [], errors: [`Ошибка валидации категорий: ${msg}`] };
    }
  }

  /**
   * Отправляет один файл в модель для классификации: является ли он квитанцией/чеком
   * об оплате (а не УПД/актом/договором и т.п.). Сумма не сравнивается.
   * Используется только для сканов/неоднозначных случаев (текст определяется детерминированно).
   */
  async verifyReceiptFile(filePath: string): Promise<ReceiptVerifyModelResult> {
    const masker = new DocumentMaskingService([filePath]);
    const maskedFilename = masker.getMaskedFilename(filePath);
    let part: RouterAIContentPart;
    try {
      part = this.buildFilePart(filePath, maskedFilename);
    } catch (err) {
      return {
        isReceipt: false,
        issue: `Не удалось подготовить файл для проверки: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    const contentParts: RouterAIContentPart[] = [
      {
        type: 'text',
        text: 'Оцени приложенный документ: это квитанция/чек об оплате или другой документ (УПД, акт, договор и т.п.)?'
      },
      part
    ];
    const messages: RouterAIMessage[] = [
      { role: 'system', content: RECEIPT_VERIFY_ROUTERAI_SYSTEM_PROMPT },
      { role: 'user', content: contentParts }
    ];

    try {
      const response = await this.withFallback(
        (model) => this.postChat(model, messages, { withFileParser: true }),
        'проверка квитанции'
      );
      this.trackUsage(response.usage);
      const rawReply = response.choices?.[0]?.message?.content || '{}';
      return parseReceiptVerifyReply(rawReply);
    } catch (error) {
      if (isAuthOrTokenError(error)) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      return { isReceipt: false, issue: `Ошибка классификации квитанции: ${msg}` };
    }
  }

  /**
   * Извлекает из одного файла счёта табличные данные: единица измерения, количество,
   * цена за единицу, сумма, ставка НДС, сумма НДС, всего с НДС. С fallback на резервную модель.
   */
  async extractBillColumns(filePath: string): Promise<BillColumnsExtractResult> {
    const masker = new DocumentMaskingService([filePath]);
    const maskedFilename = masker.getMaskedFilename(filePath);
    let part: RouterAIContentPart;
    try {
      part = this.buildFilePart(filePath, maskedFilename);
    } catch (err) {
      return {
        unit: null,
        quantity: null,
        pricePerUnit: null,
        amount: null,
        vatPercent: null,
        vatAmount: null,
        totalWithVat: null,
        error: `Не удалось подготовить файл: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    const contentParts: RouterAIContentPart[] = [
      { type: 'text', text: 'Извлеки табличные данные из приложенного счёта.' },
      part
    ];
    const messages: RouterAIMessage[] = [
      { role: 'system', content: BILL_COLUMNS_EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: contentParts }
    ];

    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let rawReply = '';
      try {
        const response = await this.withFallback(
          (model) => this.postChat(model, messages, { withFileParser: true }),
          `извлечение столбцов счёта (попытка ${attempt + 1})`
        );
        this.trackUsage(response.usage);
        rawReply = response.choices?.[0]?.message?.content || '';
      } catch (error) {
        if (isAuthOrTokenError(error)) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      const result = normalizeColumnsReply(rawReply);
      if (result) return result;
      lastError = `Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}`;
    }

    return {
      unit: null,
      quantity: null,
      pricePerUnit: null,
      amount: null,
      vatPercent: null,
      vatAmount: null,
      totalWithVat: null,
      error: lastError ?? 'Модель не вернула валидный JSON'
    };
  }

  /**
   * Классификация категории счёта по извлечённому тексту (fallback детерминированного
   * классификатора для текстовых документов).
   */
  async classifyBillCategoryByText(text: string): Promise<BillCategory | null> {
    const message =
      `Определи категорию счёта по тексту. Варианты: ${BILL_CATEGORIES.join(', ')}.\n` +
      `Подсказки: electricity=электроэнергия; heat=теплоэнергия; water=водоканал/водоснабжение/водоотведение; ` +
      `garbage=вывоз мусора/обращение с ТКО; maintenance=содержание помещения (Наш Дом).\n` +
      `Отвечай СТРОГО одним словом-категорией. Если не уверен — верни unknown.\n\nТекст:\n${text.slice(0, 6000)}`;
    try {
      const reply = await this.chatOnce(BILL_CLASSIFY_SYSTEM_PROMPT, message);
      const cleaned = reply.trim().toLowerCase();
      const match = (BILL_CATEGORIES as readonly string[]).find((c) => cleaned.includes(c));
      return (match as BillCategory) ?? null;
    } catch {
      return null;
    }
  }
}

/** Ошибка RouterAI с флагом isTokenError (401/402 — конфигурационные, не fallback). */
export class RouterAIError extends Error {
  isTokenError?: boolean;
  constructor(message: string) {
    super(message);
    this.name = 'RouterAIError';
  }
}

/** Zod-схема ответа модели для табличных данных счёта. */
const billColumnsSchema = z.object({
  unit: z.string().nullable().optional(),
  quantity: z.union([z.number(), z.string()]).nullable().optional(),
  pricePerUnit: z.union([z.number(), z.string()]).nullable().optional(),
  amount: z.union([z.number(), z.string()]).nullable().optional(),
  vatPercent: z.union([z.number(), z.string()]).nullable().optional(),
  vatAmount: z.union([z.number(), z.string()]).nullable().optional(),
  totalWithVat: z.union([z.number(), z.string()]).nullable().optional()
});

/** Нормализует ответ модели: достаёт JSON, валидирует Zod, переводит строковые числа через parseRuNumber. */
function normalizeColumnsReply(rawReply: string): BillColumnsExtractResult | null {
  const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  const r = billColumnsSchema.safeParse(parsed);
  if (!r.success) return null;
  const v = r.data;
  return {
    unit: typeof v.unit === 'string' && v.unit.trim() ? v.unit.trim() : null,
    quantity: parseRuNumber(typeof v.quantity === 'string' ? v.quantity : v.quantity == null ? '' : String(v.quantity)),
    pricePerUnit: parseRuNumber(typeof v.pricePerUnit === 'string' ? v.pricePerUnit : v.pricePerUnit == null ? '' : String(v.pricePerUnit)),
    amount: parseRuNumber(typeof v.amount === 'string' ? v.amount : v.amount == null ? '' : String(v.amount)),
    vatPercent: parseRuNumber(typeof v.vatPercent === 'string' ? v.vatPercent : v.vatPercent == null ? '' : String(v.vatPercent)),
    vatAmount: parseRuNumber(typeof v.vatAmount === 'string' ? v.vatAmount : v.vatAmount == null ? '' : String(v.vatAmount)),
    totalWithVat: parseRuNumber(typeof v.totalWithVat === 'string' ? v.totalWithVat : v.totalWithVat == null ? '' : String(v.totalWithVat)),
    error: null
  };
}

const BILL_CLASSIFY_SYSTEM_PROMPT =
  'Ты — классификатор счетов за коммунальные услуги. Отвечай только одним словом-категорией из списка: electricity, heat, water, garbage, maintenance, unknown.';

export interface BillValidationResult {
  valid: boolean;
  coveredCategories: BillCategory[];
  missingCategories: BillCategory[];
  errors: string[];
  details: Array<{
    file: string;
    category: BillCategory | null;
    hasAmount: boolean;
    amount?: number | null;
    issue: string | null;
  }>;
  isTokenError?: boolean;
}

export interface ReceiptVerifyModelResult {
  isReceipt: boolean;
  issue: string | null;
}

export interface BillColumnsExtractResult {
  unit: string | null;
  quantity: number | null;
  pricePerUnit: number | null;
  amount: number | null;
  vatPercent: number | null;
  vatAmount: number | null;
  totalWithVat: number | null;
  error: string | null;
}

/** Результат модельной пакетной валидации (только детали + ошибки; итог считает роутер). */
export interface ModelBatchValidationResult {
  details: BillValidationResult['details'];
  errors: string[];
}

export function parseReceiptVerifyReply(rawReply: string): ReceiptVerifyModelResult {
  const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { isReceipt: false, issue: `Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}` };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { isReceipt: Boolean(parsed.isReceipt), issue: parsed.issue ?? null };
  } catch (e) {
    return { isReceipt: false, issue: `Ошибка парсинга JSON ответа модели: ${e}` };
  }
}

/** Накопленное потребление RouterAI за время жизни процесса (для метрики стоимости). */
export function getRouterAIUsageStats(): RouterAIUsageStats {
  return routerAIService.getUsageStats();
}

/** Санитизация ответа модели: срезает markdown, ломающий разметку Telegram. */
export function sanitizeModelOutput(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/^\s{0,4}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ');
}

export const routerAIService = new RouterAIService();
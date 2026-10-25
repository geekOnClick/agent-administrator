import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BILLS_VALIDATE_SYSTEM_PROMPT,
  RECEIPT_VERIFY_ROUTERAI_SYSTEM_PROMPT,
  BILL_COLUMNS_EXTRACT_SYSTEM_PROMPT,
  BILL_CATEGORY_LABELS,
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

/** Накопленное потребление RouterAI (HARD-режим) за время жизни процесса — основа метрики стоимости. */
export interface RouterAIUsageStats {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costRub: number;
}

export class RouterAIService {
  private apiKey: string;
  private model: string;
  private apiUrl: string;
  private readonly stats: RouterAIUsageStats = { requests: 0, promptTokens: 0, completionTokens: 0, costRub: 0 };

  constructor() {
    this.apiKey = process.env.AIROUTER_API_KEY || '';
    this.model = process.env.AIROUTER_MODEL || 'google/gemini-3-flash';
    this.apiUrl = process.env.ROUTERAI_API_URL || 'https://routerai.ru/api/v1/chat/completions';
    if (!this.apiKey) {
      throw new Error('AIROUTER_API_KEY не задан в .env');
    }
  }

  getModelName(): string {
    return this.model;
  }

  /** Одноразовый текстовый чат с RouterAI (без истории, без файла) — для классификации по тексту. */
  async chatOnce(systemPrompt: string, message: string): Promise<string> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`RouterAI API error ${response.status}: ${errText}`);
    }
    const data = (await response.json()) as RouterAIResponse;
    this.trackUsage(data.usage);
    return data.choices?.[0]?.message?.content || '';
  }

  /** Копия накопленной статистики потребления (для метрики стоимости цикла/сессии). */
  getUsageStats(): RouterAIUsageStats {
    return { ...this.stats };
  }

  /**
   * Учитывает usage ответа RouterAI: накапливает токены и считает стоимость по тарифам
   * из .env (ROUTERAI_INPUT_RUB_PER_1M / ROUTERAI_OUTPUT_RUB_PER_1M). Тариф 0 — не учитывать.
   */
  private trackUsage(usage: RouterAIResponse['usage']): void {
    this.stats.requests += 1;
    if (!usage) return;
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
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
        file_data: `data:${mime};base64,${b64}`,
      },
    };
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
      text: `Проанализируй приложенные документы (${filePaths.length} шт.). Определи категорию каждого счёта и проверь, есть ли сумма к оплате.`,
    });

    // Логируем таблицу маскирования (только маскированное имя — оригинал не светим в stdout)
    console.log(`[masking] Отправка ${filePaths.length} файл(ов) в LLM под псевдонимами:`);
    for (const [masked, original] of masker.getMaskMap()) {
      console.log(`  ${masked}  ← ${original}`);
    }

    const messages: RouterAIMessage[] = [
      { role: 'system', content: BILLS_VALIDATE_SYSTEM_PROMPT },
      { role: 'user', content: contentParts },
    ];

    const body = {
      model: this.model,
      messages,
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
    };

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      // Проверяем, закончились ли токены (402 или сообщение о балансе)
      if (
        response.status === 402 ||
        errText.toLowerCase().includes('insufficient') ||
        errText.toLowerCase().includes('balance') ||
        errText.toLowerCase().includes('quota') ||
        errText.toLowerCase().includes('token')
      ) {
        const tokenError = new Error(`RouterAI: недостаточно токенов для выполнения запроса (${response.status}): ${errText}`);
        (tokenError as any).isTokenError = true;
        throw tokenError;
      }
      throw new Error(`RouterAI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as RouterAIResponse;
    this.trackUsage(data.usage);
    const rawReply = data.choices?.[0]?.message?.content || '{}';

    // Извлекаем JSON из ответа модели
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { details: [], errors: [`Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}`] };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as BillValidationResult;
      // Восстанавливаем оригинальные имена файлов: LLM вернула маскированные имена (doc_001.pdf и т.п.)
      const unmasked = masker.unmaskBillValidationResult(parsed);
      return { details: unmasked.details ?? [], errors: parsed.errors ?? [] };
    } catch (e) {
      return { details: [], errors: [`Ошибка парсинга JSON ответа модели: ${e}`] };
    }
  }

  /**
   * Отправляет один файл в роутерайз (всегда HARD-уровень сложности — RouterAI) для классификации:
   * является ли это действительно квитанция/чек об оплате (а не УПД/акт/договор и т.п.).
   * Сумма не сравнивается — проверяется только факт наличия квитанции.
   */
  async verifyReceiptFile(filePath: string): Promise<ReceiptVerifyModelResult> {
    // Квитанции отправляются по одному файлу — маскируем имя перед отправкой
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

    const body = {
      model: this.model,
      messages,
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]
    };

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      if (
        response.status === 402 ||
        errText.toLowerCase().includes('insufficient') ||
        errText.toLowerCase().includes('balance') ||
        errText.toLowerCase().includes('quota') ||
        errText.toLowerCase().includes('token')
      ) {
        const tokenError = new Error(
          `RouterAI: недостаточно токенов для выполнения запроса (${response.status}): ${errText}`
        );
        (tokenError as any).isTokenError = true;
        throw tokenError;
      }
      throw new Error(`RouterAI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as RouterAIResponse;
    this.trackUsage(data.usage);
    const rawReply = data.choices?.[0]?.message?.content || '{}';

    return parseReceiptVerifyReply(rawReply);
  }

  /**
   * Извлекает из одного файла счёта табличные данные: единица измерения, количество,
   * цена за единицу, сумма, ставка НДС, сумма НДС, всего с НДС. Всегда выполняется
   * в режиме HARD через RouterAI.
   */
  async extractBillColumns(filePath: string): Promise<BillColumnsExtractResult> {
    // Маскируем имя файла перед отправкой в LLM
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

    const body = {
      model: this.model,
      messages,
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]
    };

    // Один вызов модели (скан/фото): с retry при невалидном/пустом JSON.
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = `Сетевая ошибка RouterAI: ${msg}`;
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        if (
          response.status === 402 ||
          errText.toLowerCase().includes('insufficient') ||
          errText.toLowerCase().includes('balance') ||
          errText.toLowerCase().includes('quota') ||
          errText.toLowerCase().includes('token')
        ) {
          const tokenError = new Error(`RouterAI: недостаточно токенов (${response.status}): ${errText}`);
          (tokenError as any).isTokenError = true;
          throw tokenError;
        }
        if (response.status === 401) {
          throw new Error(`RouterAI API error 401 (невалидный ключ): ${errText}`);
        }
        lastError = `RouterAI API error ${response.status}: ${errText}`;
        continue;
      }

      const data = (await response.json()) as RouterAIResponse;
      this.trackUsage(data.usage);
      const rawReply = data.choices?.[0]?.message?.content || '';
      const result = normalizeColumnsReply(rawReply);
      if (result) return result;
      lastError = result === null ? `Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}` : lastError;
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
   * Классификация категории счёта по ИЗВЛЕЧЁННОМУ ТЕКСТУ (без загрузки файла в модель —
   * дёшево и надёжно). Используется как fallback детерминированного классификатора
   * для текстовых документов; для сканов классификация идёт вместе с извлечением через
   * validateBillCategoriesByModel (загрузка файла/изображения).
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

/** Одноразовый текстовый чат с RouterAI (без истории). */
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
  /** true, если цикл прерван из-за исчерпания токенов RouterAI */
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
    return {
      isReceipt: false,
      issue: `Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}`
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      isReceipt: Boolean(parsed.isReceipt),
      issue: parsed.issue ?? null
    };
  } catch (e) {
    return {
      isReceipt: false,
      issue: `Ошибка парсинга JSON ответа модели: ${e}`
    };
  }
}

/**
 * Накопленное потребление RouterAI за время жизни процесса: число запросов, токены
 * и стоимость в рублях (по тарифам из .env). Используется для метрики стоимости
 * документных задач (HARD-режим) в отчётах цикла bills и evals.
 */
export function getRouterAIUsageStats(): RouterAIUsageStats {
  return routerAIService.getUsageStats();
}

export const routerAIService = new RouterAIService();

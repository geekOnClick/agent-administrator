import fs from 'node:fs';
import path from 'node:path';
import {
  BILLS_VALIDATE_SYSTEM_PROMPT,
  RECEIPT_VERIFY_ROUTERAI_SYSTEM_PROMPT,
  BILL_COLUMNS_EXTRACT_SYSTEM_PROMPT,
  BILL_CATEGORIES,
  BillCategory
} from '../llm/prompts.js';
import { config } from '../config.js';
import { DocumentMaskingService } from './DocumentMaskingService.js';

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
   * Отправляет файлы в модель для валидации категорий счетов.
   */
  async validateBillCategories(filePaths: string[]): Promise<BillValidationResult> {
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
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: [...BILL_CATEGORIES],
        errors: ['Не удалось подготовить ни одного файла для валидации'],
        details: []
      };
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
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: [...BILL_CATEGORIES],
        errors: [`Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}`],
        details: []
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as BillValidationResult;
      // Восстанавливаем оригинальные имена файлов: LLM вернула маскированные имена (doc_001.pdf и т.п.)
      return masker.unmaskBillValidationResult(parsed);
    } catch (e) {
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: [...BILL_CATEGORIES],
        errors: [`Ошибка парсинга JSON ответа модели: ${e}`],
        details: []
      };
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
      throw new Error(`RouterAI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as RouterAIResponse;
    this.trackUsage(data.usage);
    const rawReply = data.choices?.[0]?.message?.content || '{}';

    const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        unit: null,
        quantity: null,
        pricePerUnit: null,
        amount: null,
        vatPercent: null,
        vatAmount: null,
        totalWithVat: null,
        error: `Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}`
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        unit: parsed.unit ?? null,
        quantity: typeof parsed.quantity === 'number' ? parsed.quantity : null,
        pricePerUnit: typeof parsed.pricePerUnit === 'number' ? parsed.pricePerUnit : null,
        amount: typeof parsed.amount === 'number' ? parsed.amount : null,
        vatPercent: typeof parsed.vatPercent === 'number' ? parsed.vatPercent : null,
        vatAmount: typeof parsed.vatAmount === 'number' ? parsed.vatAmount : null,
        totalWithVat: typeof parsed.totalWithVat === 'number' ? parsed.totalWithVat : null,
        error: null
      };
    } catch (e) {
      return {
        unit: null,
        quantity: null,
        pricePerUnit: null,
        amount: null,
        vatPercent: null,
        vatAmount: null,
        totalWithVat: null,
        error: `Ошибка парсинга JSON ответа модели: ${e}`
      };
    }
  }
}

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

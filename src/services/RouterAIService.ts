import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  BILLS_WITH_MODEL_SYSTEM_PROMPT,
  BILLS_VALIDATE_SYSTEM_PROMPT,
  RECEIPT_VERIFY_ROUTERAI_SYSTEM_PROMPT,
  BILL_COLUMNS_EXTRACT_SYSTEM_PROMPT,
  BILL_CATEGORIES,
  BillCategory
} from '../llm/prompts/profiles.js';

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

export class RouterAIService {
  private apiKey: string;
  private model: string;
  private apiUrl: string;

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

  private toBase64(filePath: string): string {
    return fs.readFileSync(filePath).toString('base64');
  }

  private isPdf(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.pdf';
  }

  private convertToPdf(filePath: string): string {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    const outPath = path.join(dir, `${baseName}.pdf`);
    if (fs.existsSync(outPath)) {
      fs.unlinkSync(outPath);
    }
    try {
      execSync(`libreoffice --headless --convert-to pdf --outdir "${dir}" "${filePath}"`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    } catch (err) {
      throw new Error(`Ошибка конвертации ${filePath} в PDF: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!fs.existsSync(outPath)) {
      throw new Error(`Конвертация не создала файл: ${outPath}`);
    }
    // Удаляем исходный файл после успешной конвертации,
    // чтобы при повторном запуске в контекст не попадали дубликаты
    fs.unlinkSync(filePath);
    return outPath;
  }

  private buildFilePart(filePath: string): RouterAIContentPart {
    const filename = path.basename(filePath);
    if (this.isPdf(filePath)) {
      const b64 = this.toBase64(filePath);
      return {
        type: 'file',
        file: {
          filename,
          file_data: `data:application/pdf;base64,${b64}`,
        },
      };
    }
    const pdfPath = this.convertToPdf(filePath);
    const b64 = this.toBase64(pdfPath);
    return {
      type: 'file',
      file: {
        filename: path.basename(pdfPath),
        file_data: `data:application/pdf;base64,${b64}`,
      },
    };
  }

  /**
   * Отправляет файлы в модель для валидации категорий счетов.
   */
  async validateBillCategories(filePaths: string[]): Promise<BillValidationResult> {
    const contentParts: RouterAIContentPart[] = [];

    for (const filePath of filePaths) {
      try {
        const part = this.buildFilePart(filePath);
        contentParts.push(part);
      } catch (err) {
        console.error(`[validate] Пропускаю файл ${filePath}:`, err);
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
      return parsed;
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
    let part: RouterAIContentPart;
    try {
      part = this.buildFilePart(filePath);
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
    const rawReply = data.choices?.[0]?.message?.content || '{}';

    return parseReceiptVerifyReply(rawReply);
  }

  /**
   * Извлекает из одного файла счёта табличные данные: единица измерения, количество,
   * цена за единицу, сумма, ставка НДС, сумма НДС, всего с НДС. Всегда выполняется
   * в режиме HARD через RouterAI.
   */
  async extractBillColumns(filePath: string): Promise<BillColumnsExtractResult> {
    let part: RouterAIContentPart;
    try {
      part = this.buildFilePart(filePath);
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

  async processBillsWithFiles(
    filePaths: string[],
    outputDir?: string
  ): Promise<{ reply: string; reportPath: string }> {
    const contentParts: RouterAIContentPart[] = [];
    const convertedFiles: string[] = [];

    for (const filePath of filePaths) {
      try {
        const part = this.buildFilePart(filePath);
        contentParts.push(part);
        if (!this.isPdf(filePath)) {
          convertedFiles.push(part.file!.filename);
        }
      } catch (err) {
        console.error(`Пропускаю файл ${filePath}:`, err);
      }
    }

    if (contentParts.length === 0) {
      throw new Error('Не удалось подготовить ни одного файла для отправки');
    }

    contentParts.unshift({
      type: 'text',
      text: `Проанализируй приложенные счета (${filePaths.length} шт.). Извлеки итоговые суммы и вычисли общую сумму по всем документам.`,
    });

    const messages: RouterAIMessage[] = [
      { role: 'system', content: BILLS_WITH_MODEL_SYSTEM_PROMPT },
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
      throw new Error(`RouterAI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as RouterAIResponse;
    const reply = data.choices?.[0]?.message?.content || 'Пустой ответ от модели';

    const timestamp = Date.now();
    const targetDir = outputDir || process.cwd();
    const reportPath = path.resolve(targetDir, `bills_with_model_report_${timestamp}.txt`);
    const reportContent = `Источник: routerai (${this.model})
Дата: ${new Date().toISOString()}
Файлов обработано: ${filePaths.length}
Конвертировано в PDF: ${convertedFiles.length}

${reply}
`;
    fs.writeFileSync(reportPath, reportContent, 'utf8');

    return { reply, reportPath };
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

export const routerAIService = new RouterAIService();

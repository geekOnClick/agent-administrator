import { Ollama, Message } from 'ollama';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { OllamaWatchdog } from './OllamaWatchdog.js';
import {
  BILLS_VALIDATE_SYSTEM_PROMPT,
  RECEIPT_VERIFY_ROUTERAI_SYSTEM_PROMPT,
  BILL_COLUMNS_EXTRACT_SYSTEM_PROMPT,
  BILL_CATEGORIES,
  BillCategory
} from './prompts.js';
import { config } from '../config.js';

/**
 * Базовая санитизация ответа модели перед показом пользователю:
 * срезает markdown-конструкции, которые ломают разметку Telegram-клиента
 * (жирный/курсив/ссылки/списки). На смысл ответа не влияет.
 */
export function sanitizeModelOutput(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // картинки — выкидываем целиком
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1 ($2)') // ссылки → текст (url)
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **жирный**
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1$2') // *курсив*
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1$2') // _курсив_
    .replace(/^\s{0,4}#{1,6}\s+/gm, '') // заголовки
    .replace(/^\s*[-*+]\s+/gm, '• '); // markdown-списки → маркер
}

interface Session {
  messages: Message[];
  systemPrompt: string;
}

// Локальные типы результатов, чтобы не тянуть зависимость от RouterAIService
// (результаты структурно совместимы с BillValidationResult/ReceiptVerifyModelResult/BillColumnsExtractResult).
export interface OllamaBillValidationResult {
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
}

export interface OllamaReceiptVerifyResult {
  isReceipt: boolean;
  issue: string | null;
}

export interface OllamaBillColumnsResult {
  unit: string | null;
  quantity: number | null;
  pricePerUnit: number | null;
  amount: number | null;
  vatPercent: number | null;
  vatAmount: number | null;
  totalWithVat: number | null;
  error: string | null;
}

/** Извлекает plain text из файла для передачи в текстовую (не vision) локальную модель. */
function extractDocumentText(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    return execSync(`pdftotext -layout "${filePath}" -`, { encoding: 'utf-8', timeout: 60000 });
  }

  if (ext === '.docx' || ext === '.doc') {
    // Конвертируем во временный PDF и читаем текст из него (исходный файл не трогаем).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-text-'));
    try {
      execSync(`libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${filePath}"`, {
        stdio: 'pipe',
        timeout: 60000
      });
      const pdfName = path.basename(filePath, ext) + '.pdf';
      const pdfPath = path.join(tmpDir, pdfName);
      if (!fs.existsSync(pdfPath)) {
        throw new Error(`Конвертация не создала файл: ${pdfPath}`);
      }
      return execSync(`pdftotext -layout "${pdfPath}" -`, { encoding: 'utf-8', timeout: 60000 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Текстовые и прочие форматы читаем как есть.
  return fs.readFileSync(filePath, 'utf-8');
}

/** Достаёт первый JSON-объект из ответа модели (модель может обернуть его в markdown/пояснения). */
function extractJson(rawReply: string): unknown {
  const jsonMatch = rawReply.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Модель не вернула валидный JSON: ${rawReply.slice(0, 200)}`);
  }
  return JSON.parse(jsonMatch[0]);
}

export class OllamaHelper {
  protected sessions: Record<string, Session> = {};

  private client: Ollama;

  constructor(
    private readonly model: string,
    private readonly systemPrompt: string,
    host: string = 'http://localhost:11434'
  ) {
    this.client = new Ollama({ host });
  }

  protected getSession(sessionId: string): Session {
    if (!this.sessions[sessionId]) {
      this.sessions[sessionId] = {
        messages: this.systemPrompt
          ? [
              {
                role: 'system',
                content: this.systemPrompt
              }
            ]
          : [],
        systemPrompt: this.systemPrompt
      };
    }
    return this.sessions[sessionId];
  }

  private applySystemPrompt(session: Session, prompt: string): void {
    const normalizedPrompt = prompt.trim();
    const firstMessage = session.messages[0];
    const hasSystemMessage = firstMessage?.role === 'system';

    if (!normalizedPrompt) {
      if (hasSystemMessage) {
        session.messages.shift();
      }
      session.systemPrompt = '';
      return;
    }

    if (hasSystemMessage) {
      firstMessage.content = normalizedPrompt;
    } else {
      session.messages.unshift({
        role: 'system',
        content: normalizedPrompt
      });
    }

    session.systemPrompt = normalizedPrompt;
  }

  async setSessionSystemPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.getSession(sessionId);
    this.applySystemPrompt(session, prompt);
  }

  async resetSession(sessionId: string): Promise<void> {
    delete this.sessions[sessionId];
  }

  /** Выгружает модель из памяти Ollama (keep_alive=0). Ошибки глушатся — выгрузка best-effort. */
  async unloadModel(model?: string): Promise<void> {
    try {
      await this.client.chat({
        model: model || this.model,
        messages: [],
        keep_alive: 0
      });
    } catch {
      // Игнорируем: выгрузка не влияет на результат.
    }
  }

  /**
   * Выгружает ВСЕ загруженные в память модели Ollama (аналог цикла
   * `for m in $(ollama ps ...); do ollama stop $m; done`).
   * Используется при завершении агента (exit/SIGINT), чтобы модели не висели в памяти.
   * Список берётся из GET /api/ps (не из парсинга вывода `ollama ps`), выгрузка — через
   * ps() клиента (то же keep_alive=0). Ошибки глушатся — остановка best-effort.
   */
  async unloadAllModels(): Promise<void> {
    let names: string[] = [];
    try {
      const ps = await this.client.ps();
      names = ps.models
        .map((m) => m.name ?? m.model)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
    } catch {
      return; // Ollama недоступна — выгружать нечего.
    }

    for (const name of names) {
      try {
        await this.client.chat({ model: name, messages: [], keep_alive: 0 });
        console.log(`[Ollama] Выгружена модель: ${name}`);
      } catch {
        console.warn(`[Ollama] Не удалось выгрузить модель: ${name}`);
      }
    }
  }

  async simpleChat(sessionId: string, message: string, overrideModel?: string): Promise<string> {
    const session = this.getSession(sessionId);
    session.messages.push({
      role: 'user',
      content: message
    });

    const model = overrideModel || this.model;
    const timeoutMs = config.ollama.requestTimeoutMs;

    const doRequest = async (_signal: AbortSignal) =>
      this.client.chat({
        model,
        messages: session.messages,
        // Защита от бесконтрольной генерации: верхняя граница токенов ответа.
        options: { num_predict: config.evals.ollamaMaxResponseTokens }
      });

    const response = timeoutMs > 0
      ? await OllamaWatchdog.run(doRequest, {
          timeoutMs,
          model,
          ollamaHost: config.ollama.host
        })
      : await doRequest(new AbortController().signal);

    const responseMessage = response.message;
    session.messages.push(responseMessage);

    return sanitizeModelOutput(responseMessage.content ?? '');
  }

  /** Одноразовый запрос без сохранения истории: системный промпт + одно сообщение. */
  private async askOnce(systemPrompt: string, message: string): Promise<string> {
    const sessionId = `once-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await this.setSessionSystemPrompt(sessionId, systemPrompt);
      return await this.simpleChat(sessionId, message);
    } finally {
      await this.resetSession(sessionId);
    }
  }

  /**
   * Fallback-версия валидации категорий счетов для случая, когда RouterAI недоступен.
   * Локальная модель не видит файл — анализирует извлечённый из него текст.
   */
  async validateBillCategoriesByText(filePaths: string[]): Promise<OllamaBillValidationResult> {
    const parts: string[] = [];
    const errors: string[] = [];

    for (const filePath of filePaths) {
      try {
        const text = extractDocumentText(filePath);
        parts.push(`=== Файл: ${path.basename(filePath)} ===\n${text}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Не удалось извлечь текст из ${path.basename(filePath)}: ${msg}`);
      }
    }

    if (parts.length === 0) {
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: [...BILL_CATEGORIES],
        errors: errors.length > 0 ? errors : ['Не удалось подготовить ни одного файла для валидации'],
        details: []
      };
    }

    const message =
      `Проанализируй тексты документов (${parts.length} шт.). Определи категорию каждого счёта и проверь, есть ли сумма к оплате.\n\n` +
      parts.join('\n\n');

    try {
      const reply = await this.askOnce(BILLS_VALIDATE_SYSTEM_PROMPT, message);
      return extractJson(reply) as OllamaBillValidationResult;
    } catch (e) {
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: [...BILL_CATEGORIES],
        errors: [...errors, `Ошибка локальной валидации: ${e instanceof Error ? e.message : String(e)}`],
        details: []
      };
    }
  }

  /** Fallback-версия классификации файла-кандидата (квитанция/чек или иной документ) по тексту. */
  async verifyReceiptByText(filePath: string): Promise<OllamaReceiptVerifyResult> {
    let text: string;
    try {
      text = extractDocumentText(filePath);
    } catch (err) {
      return {
        isReceipt: false,
        issue: `Не удалось извлечь текст из файла: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    const message =
      'Оцени текст документа: это квитанция/чек об оплате или другой документ (УПД, акт, договор и т.п.)?\n\n' +
      `=== Файл: ${path.basename(filePath)} ===\n${text}`;

    try {
      const reply = await this.askOnce(RECEIPT_VERIFY_ROUTERAI_SYSTEM_PROMPT, message);
      const parsed = extractJson(reply) as { isReceipt?: unknown; issue?: unknown };
      return {
        isReceipt: Boolean(parsed.isReceipt),
        issue: typeof parsed.issue === 'string' ? parsed.issue : null
      };
    } catch (e) {
      return {
        isReceipt: false,
        issue: `Ошибка локальной проверки квитанции: ${e instanceof Error ? e.message : String(e)}`
      };
    }
  }

  /** Fallback-версия извлечения табличных данных счёта по тексту. */
  async extractBillColumnsByText(filePath: string): Promise<OllamaBillColumnsResult> {
    const empty: OllamaBillColumnsResult = {
      unit: null,
      quantity: null,
      pricePerUnit: null,
      amount: null,
      vatPercent: null,
      vatAmount: null,
      totalWithVat: null,
      error: null
    };

    let text: string;
    try {
      text = extractDocumentText(filePath);
    } catch (err) {
      return { ...empty, error: `Не удалось извлечь текст из файла: ${err instanceof Error ? err.message : String(err)}` };
    }

    const message =
      'Извлеки табличные данные из текста счёта.\n\n' +
      `=== Файл: ${path.basename(filePath)} ===\n${text}`;

    try {
      const reply = await this.askOnce(BILL_COLUMNS_EXTRACT_SYSTEM_PROMPT, message);
      const parsed = extractJson(reply) as Record<string, unknown>;
      const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
      return {
        unit: typeof parsed.unit === 'string' ? parsed.unit : null,
        quantity: num(parsed.quantity),
        pricePerUnit: num(parsed.pricePerUnit),
        amount: num(parsed.amount),
        vatPercent: num(parsed.vatPercent),
        vatAmount: num(parsed.vatAmount),
        totalWithVat: num(parsed.totalWithVat),
        error: null
      };
    } catch (e) {
      return { ...empty, error: `Ошибка локального извлечения столбцов: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

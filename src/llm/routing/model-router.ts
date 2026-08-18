import { OllamaHelper } from '../providers/ollama.js';
import {
  RouterAIService,
  routerAIService,
  BillValidationResult,
  ReceiptVerifyModelResult,
  BillColumnsExtractResult
} from '../../services/RouterAIService.js';
import { ROUTER_SYSTEM_PROMPT } from '../prompts/profiles.js';

export type ModelMode = 'EASY' | 'HARD';

/**
 * Задачи (команды) агента, для каждой из которых нужно выбрать модель.
 * 'chat' зарезервирован для свободного tool-calling диалога (например, будущий
 * Telegram-бот), где заранее неизвестно, требует ли конкретное сообщение
 * распознавания документов — режим для него определяет локальная модель-классификатор.
 */
export type AgentTask = 'ask' | 'askMeters' | 'bills' | 'meters' | 'report' | 'chat';

/**
 * Статическая таблица режимов по командам. Команда сама однозначно определяет,
 * какого класса задача выполняется, поэтому классификация через модель не нужна:
 * - ask / askMeters — ответ по уже проиндексированным в векторной базе данным -> EASY (локальная Ollama).
 * - bills           — распознавание сканов/PDF счетов, квитанций, таблиц счёта -> HARD (облачная RouterAI).
 * - meters          — ввод показаний считается задачей того же класса, что и bills (документо-ориентированная
 *                     обработка коммунальных платежей), поэтому классифицируется HARD, хотя сегодняшняя
 *                     реализация (ручной ввод чисел) вообще не вызывает чат-модель — вызывается только
 *                     локальная модель эмбеддингов (OLLAMA_EMBED_MODEL) для переиндексации векторной базы.
 * - report          — чистая генерация .docx из уже проиндексированных данных, модель не вызывается -> EASY.
 */
const STATIC_TASK_MODE: Partial<Record<AgentTask, ModelMode>> = {
  ask: 'EASY',
  askMeters: 'EASY',
  bills: 'HARD',
  meters: 'HARD',
  report: 'EASY'
};

/**
 * Единый роутер моделей агента. Заменяет собой две ранее независимые схемы
 * (EASY/HARD-роутер по сообщению для чата и отдельный роутер документных задач):
 * теперь решение о режиме принимается ОДНИМ роутером для любой задачи агента,
 * и только после этого решения выполняется обращение к соответствующей модели
 * (локальная Ollama для EASY, облачная RouterAI для HARD).
 */
export class ModelRouter {
  constructor(
    private readonly localClassifier: OllamaHelper,
    private readonly routerModel: string,
    private readonly routerAI: RouterAIService
  ) {}

  /**
   * Определяет режим для задачи. Для известных команд (ask/askMeters/bills/meters/report)
   * режим известен статически и определяется без единого обращения к какой-либо модели.
   * Для 'chat' (свободный запрос) решение принимает локальная модель-классификатор
   * по содержимому сообщения (см. ROUTER_SYSTEM_PROMPT — там описаны правила классификации).
   */
  async resolveMode(task: AgentTask, freeformMessage?: string): Promise<ModelMode> {
    const staticMode = STATIC_TASK_MODE[task];
    if (staticMode) {
      return staticMode;
    }
    return this.classifyFreeform(freeformMessage ?? '');
  }

  /** Тот же resolveMode, но сразу логирует принятое решение в консоль. */
  async resolveModeWithLog(task: AgentTask, label: string, freeformMessage?: string): Promise<ModelMode> {
    const mode = await this.resolveMode(task, freeformMessage);
    this.logDecision(label, mode);
    return mode;
  }

  private async classifyFreeform(message: string): Promise<ModelMode> {
    const sessionId = 'router-temp-session';
    try {
      await this.localClassifier.setSessionSystemPrompt(sessionId, ROUTER_SYSTEM_PROMPT);
      const response = await this.localClassifier.simpleChat(sessionId, message, this.routerModel);
      await this.localClassifier.resetSession(sessionId);
      return response.toUpperCase().includes('HARD') ? 'HARD' : 'EASY';
    } catch (error) {
      console.error(`[Роутер] Ошибка классификации свободного запроса: ${error}. По умолчанию — HARD.`);
      return 'HARD';
    }
  }

  private logDecision(label: string, mode: ModelMode): void {
    const modelLabel = mode === 'HARD' ? `RouterAI (${this.routerAI.getModelName()})` : 'локальная модель Ollama';
    console.log(`[Роутер] ${label}: режим ${mode}. Модель для задачи — ${modelLabel}`);
  }

  /** Анализ документов и определение категорий счетов (шаг валидации ReAct-цикла bills). */
  async validateBillCategories(filePaths: string[]): Promise<BillValidationResult> {
    const mode = await this.resolveMode('bills');
    this.logDecision(`Валидация категорий счетов (${filePaths.length} файлов)`, mode);

    return this.routerAI.validateBillCategories(filePaths);
  }

  /** Классификация файла-кандидата: квитанция/чек об оплате или иной документ. */
  async verifyReceiptFile(filePath: string): Promise<ReceiptVerifyModelResult> {
    const mode = await this.resolveMode('bills');
    const fileName = filePath.split('/').pop() || filePath;
    this.logDecision(`Проверка квитанции — ${fileName}`, mode);

    return this.routerAI.verifyReceiptFile(filePath);
  }

  /** Извлечение табличных данных счёта (единица, количество, сумма, НДС и т.д.). */
  async extractBillColumns(filePath: string): Promise<BillColumnsExtractResult> {
    const mode = await this.resolveMode('bills');
    const fileName = filePath.split('/').pop() || filePath;
    this.logDecision(`Анализ столбцов счёта — ${fileName}`, mode);

    return this.routerAI.extractBillColumns(filePath);
  }

  getModelName(): string {
    return this.routerAI.getModelName();
  }
}

const host = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const routerModel = process.env.OLLAMA_ROUTER_MODEL || process.env.OLLAMA_MODEL || 'gemma4:e4b-8k';
const localClassifier = new OllamaHelper(routerModel, ROUTER_SYSTEM_PROMPT, host);

export const agentModelRouter = new ModelRouter(localClassifier, routerModel, routerAIService);

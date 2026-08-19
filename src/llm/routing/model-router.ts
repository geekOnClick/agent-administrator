import { OllamaHelper } from '../ollama-helper.js';
import {
  RouterAIService,
  routerAIService,
  BillValidationResult,
  ReceiptVerifyModelResult,
  BillColumnsExtractResult
} from '../../services/RouterAIService.js';
import { ROUTER_SYSTEM_PROMPT, AGENT_TASK_DESCRIPTIONS } from '../prompts.js';
import { config } from '../../config.js';

export type ModelMode = 'EASY' | 'HARD';

/**
 * Задачи (команды) агента. Свободного текстового чата в агенте нет: общение с моделью
 * доступно только через команды, поэтому для каждой задано описание возможностей
 * (см. AGENT_TASK_DESCRIPTIONS), по которому классификатор выбирает режим.
 */
export type AgentTask = 'ask' | 'askMeters' | 'bills' | 'meters' | 'report';

/** true, если ошибка RouterAI — это конфигурационная проблема (невалидный ключ / кончился баланс),
 * а не недоступность сервиса: такие ошибки не приводят к fallback на локальную модель. */
function isAuthOrTokenError(error: unknown): boolean {
  if (error instanceof Error && (error as any).isTokenError === true) {
    return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /\b(401|402)\b/.test(msg);
}

/**
 * Единый роутер моделей агента (модельная оркестрация): для любой задачи решение о режиме
 * принимает локальная модель-классификатор (Ollama, OLLAMA_ROUTER_MODEL) по описанию задачи.
 * Документные задачи (HARD) выполняет облачная RouterAI; при её недоступности (сеть/5xx/таймаут)
 * выполняется fallback на локальную Ollama по извлечённому из документа тексту. Остальные задачи
 * (EASY) выполняет локальная Ollama.
 */
export class ModelRouter {
  /** Кэш решений классификатора по командам: режим детерминирован описанием команды,
   * поэтому в пределах сессии классифицируем каждую команду один раз. */
  private readonly modeCache = new Map<AgentTask, ModelMode>();

  constructor(
    private readonly localClassifier: OllamaHelper,
    private readonly routerModel: string,
    private readonly routerAI: RouterAIService
  ) {}

  /**
   * Определяет режим для задачи, передавая её описание локальному классификатору.
   * Решение кэшируется по команде: повторные вызовы для той же задачи не дёргают классификатор.
   * Ошибка классификатора (недоступная Ollama) пробрасывается наверх — молчаливого дефолта нет.
   */
  async resolveMode(task: AgentTask): Promise<ModelMode> {
    const cached = this.modeCache.get(task);
    if (cached) {
      return cached;
    }

    const description = AGENT_TASK_DESCRIPTIONS[task];
    const sessionId = `router-${task}`;
    try {
      await this.localClassifier.setSessionSystemPrompt(sessionId, ROUTER_SYSTEM_PROMPT);
      const response = await this.localClassifier.simpleChat(sessionId, description, this.routerModel);
      const mode: ModelMode = response.toUpperCase().includes('HARD') ? 'HARD' : 'EASY';
      this.modeCache.set(task, mode);
      return mode;
    } finally {
      await this.localClassifier.resetSession(sessionId);
    }
  }

  /** Тот же resolveMode, но сразу логирует принятое решение в консоль. */
  async resolveModeWithLog(task: AgentTask, label: string): Promise<ModelMode> {
    const wasCached = this.modeCache.has(task);
    const mode = await this.resolveMode(task);
    this.logDecision(label, mode, wasCached);
    return mode;
  }

  /**
   * Выгружает локальную модель-классификатор из памяти Ollama (keep_alive=0).
   * Вызывается после выбора маршрута, чтобы модель не грела CPU на фоне, пока задачу выполняет RouterAI.
   * Ошибки выгрузки не критичны и глушатся.
   */
  private async unloadClassifier(): Promise<void> {
    await this.localClassifier.unloadModel(this.routerModel);
  }

  private logDecision(label: string, mode: ModelMode, cached: boolean): void {
    const source = cached ? 'кэш' : 'классификатор';
    const modelLabel = mode === 'HARD' ? `RouterAI (${this.routerAI.getModelName()})` : 'локальная модель Ollama';
    console.log(`[Роутер] ${label}: режим ${mode} (${source}). Выполнение — ${modelLabel}`);
  }

  private logFallback(operation: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Роутер] RouterAI недоступен (${operation}): ${msg}. Fallback на локальную модель Ollama.`);
  }

  /**
   * Анализ документов и определение категорий счетов (шаг валидации ReAct-цикла bills).
   * Основной путь — RouterAI; при его недоступности — локальная Ollama по тексту документов.
   */
  async validateBillCategories(filePaths: string[]): Promise<BillValidationResult> {
    await this.resolveModeWithLog('bills', `Валидация категорий счетов (${filePaths.length} файлов)`);
    await this.unloadClassifier();

    try {
      return await this.routerAI.validateBillCategories(filePaths);
    } catch (error) {
      if (isAuthOrTokenError(error)) {
        throw error;
      }
      this.logFallback('валидация категорий', error);
      return this.localClassifier.validateBillCategoriesByText(filePaths);
    }
  }

  /** Классификация файла-кандидата: квитанция/чек об оплате или иной документ. */
  async verifyReceiptFile(filePath: string): Promise<ReceiptVerifyModelResult> {
    const fileName = filePath.split('/').pop() || filePath;
    await this.resolveModeWithLog('bills', `Проверка квитанции — ${fileName}`);
    await this.unloadClassifier();

    try {
      return await this.routerAI.verifyReceiptFile(filePath);
    } catch (error) {
      if (isAuthOrTokenError(error)) {
        throw error;
      }
      this.logFallback('проверка квитанции', error);
      return this.localClassifier.verifyReceiptByText(filePath);
    }
  }

  /** Извлечение табличных данных счёта (единица, количество, сумма, НДС и т.д.). */
  async extractBillColumns(filePath: string): Promise<BillColumnsExtractResult> {
    const fileName = filePath.split('/').pop() || filePath;
    await this.resolveModeWithLog('bills', `Анализ столбцов счёта — ${fileName}`);
    await this.unloadClassifier();

    try {
      return await this.routerAI.extractBillColumns(filePath);
    } catch (error) {
      if (isAuthOrTokenError(error)) {
        throw error;
      }
      this.logFallback('извлечение столбцов счёта', error);
      return this.localClassifier.extractBillColumnsByText(filePath);
    }
  }

  getModelName(): string {
    return this.routerAI.getModelName();
  }
}

const routerModel = config.ollama.routerModel;
const localClassifier = new OllamaHelper(routerModel, ROUTER_SYSTEM_PROMPT, config.ollama.host);

export const agentModelRouter = new ModelRouter(localClassifier, routerModel, routerAIService);

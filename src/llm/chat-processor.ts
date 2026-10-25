import { ASK_SYSTEM_PROMPT, ASK_METERS_SYSTEM_PROMPT } from './prompts.js';
import { agentModelRouter } from './routing/model-router.js';
import { billsLedgerVectorService } from '../services/vector/BillsLedgerVectorService.js';
import { billsPeriodReportService, parsePeriodArg, PeriodReportResult } from '../services/BillsPeriodReportService.js';
import { docxMetersTableService, DocxMeterAppendResult } from '../services/DocxMetersTableService.js';
import { metersVectorService } from '../services/vector/MetersVectorService.js';
import { BillsCycleService } from '../services/BillsCycleService.js';
import { config } from '../config.js';

// Формат команды режима meters: "el-00000,vod-00000" (количество цифр может быть любым).
const METERS_INPUT_REGEX = /^el-(\d+),vod-(\d+)$/;

export interface MeterReadingsResult {
  electricity: DocxMeterAppendResult;
  water: DocxMeterAppendResult;
  rowsIndexed: number;
}

/** Минимальный контракт векторного поиска, общий для ask/askMeters. */
interface VectorSearchSource {
  search(query: string): Promise<unknown[]>;
  formatSearchContext(rows: never[]): string;
}

interface VectorAskOptions {
  source: VectorSearchSource;
  systemPrompt: string;
  /** Заголовок блока контекста в итоговом промпте. */
  contextLabel: string;
  /** Сообщение при ошибке обращения к векторной базе. */
  errorHint: string;
}

/**
 * LLM-инфраструктура агента: общие операции режимов ask / askMeters / meters / report.
 * Все LLM-вызовы идут через облачную RouterAI (через agentModelRouter / RouterAIService),
 * с автоматическим fallback на резервную модель (AIROUTER_MODEL_ADDITIONAL) при
 * недоступности основной. Локальная Ollama из проекта удалена.
 * Оркестрация цикла счетов (bills/retry/continue) вынесена в BillsCycleService,
 * инструменты вызываются напрямую в процессе (см. src/tools/registry.ts).
 */
export class ChatProcessor {
  readonly billsCycle: BillsCycleService;
  private ledgerVectorService = billsLedgerVectorService;
  private metersTableService = docxMetersTableService;
  private metersVectorService = metersVectorService;

  constructor() {
    this.billsCycle = new BillsCycleService();
  }

  // Инициализация (раньше поднимала локальную Ollama — теперь no-op, модели облачные).
  async init() {
    /* no-op */
  }

  async resetSession(sessionId: string): Promise<void> {
    await agentModelRouter.resetSession(sessionId);
  }

  /**
   * Режим report: строит отдельный .docx-отчёт с таблицей сумм за указанный период
   * (ввод вида "05/26-08/26"), исходя из актуальной таблицы учёта.
   */
  async generatePeriodReport(periodArg: string): Promise<PeriodReportResult> {
    const period = parsePeriodArg(periodArg);
    // Данные берутся из векторной базы (FalkorDB) — источник правды для ответа.
    // .docx исходной таблицы используется внутри billsPeriodReportService только как
    // шаблон структуры/стилей таблицы, а не источник данных.
    const ledgerRows = await this.ledgerVectorService.getAllRows();
    return billsPeriodReportService.generateReport(
      config.bills.ledgerDocxPath,
      ledgerRows,
      period,
      config.bills.reportOutputDir
    );
  }

  /**
   * Режим ask: отвечает на вопрос пользователя по таблице учёта коммунальных
   * платежей: выполняет векторный поиск по FalkorDB, формирует контекст из
   * найденных строк и передает его в модель вместе с вопросом.
   */
  async askAboutLedger(sessionId: string, question: string): Promise<string> {
    return this.askWithVectorContext(sessionId, question, {
      source: this.ledgerVectorService,
      systemPrompt: ASK_SYSTEM_PROMPT,
      contextLabel: 'Контекст из таблицы учёта коммунальных платежей (самые подходящие строки)',
      errorHint: 'Убедитесь, что FalkorDB запущен и таблица уже была актуализирована (команда bills).'
    });
  }

  /**
   * Разбирает ввод команды режима meters вида "el-00000,vod-00000" (количество цифр любое).
   * Возвращает null, если строка не соответствует формату.
   */
  parseMetersInput(raw: string): { electricity: string; water: string } | null {
    const match = METERS_INPUT_REGEX.exec(raw.trim());
    if (!match) {
      return null;
    }
    return { electricity: match[1], water: match[2] };
  }

  /**
   * Режим meters: добавляет новые строки (текущая дата + переданное показание) в таблицы
   * "электроэнергия.docx" и "водоканал.docx", после чего переиндексирует векторную базу.
   */
  async recordMeterReadings(electricityValue: string, waterValue: string): Promise<MeterReadingsResult> {
    const now = new Date();

    const electricity = await this.metersTableService.appendMeterRow(
      config.meters.electricityDocxPath,
      electricityValue,
      now
    );
    const water = await this.metersTableService.appendMeterRow(config.meters.waterDocxPath, waterValue, now);

    const { rowsIndexed } = await this.metersVectorService.syncMetersToVectorStore(
      config.meters.electricityDocxPath,
      config.meters.waterDocxPath
    );

    return { electricity, water, rowsIndexed };
  }

  /**
   * Режим askMeters: отвечает на вопрос пользователя по таблицам показания счётчиков:
   * выполняет векторный поиск по FalkorDB, формирует контекст из найденных строк
   * и передает его в модель вместе с вопросом.
   */
  async askAboutMeters(sessionId: string, question: string): Promise<string> {
    return this.askWithVectorContext(sessionId, question, {
      source: this.metersVectorService,
      systemPrompt: ASK_METERS_SYSTEM_PROMPT,
      contextLabel: 'Контекст из таблиц показания счётчиков (самые подходящие строки)',
      errorHint: 'Убедитесь, что FalkorDB запущен и таблицы показания счётчика уже актуализированы (команда meters).'
    });
  }

  /**
   * Общий сценарий режимов ask/askMeters: векторный поиск контекста по вопросу
   * и ответ модели RouterAI строго по этому контексту.
   */
  private async askWithVectorContext(
    sessionId: string,
    question: string,
    options: VectorAskOptions
  ): Promise<string> {
    await agentModelRouter.setSessionSystemPrompt(sessionId, options.systemPrompt);

    let contextText: string;
    try {
      const hits = await options.source.search(question);
      contextText = options.source.formatSearchContext(hits as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `⛔ Не удалось выполнить поиск по векторной базе данных: ${msg}. ${options.errorHint}`;
    }

    const prompt = `Вопрос пользователя: ${question}

${options.contextLabel}:
${contextText}

Ответь на вопрос пользователя, используя только этот контекст.`;

    return await agentModelRouter.chat(sessionId, prompt);
  }

  /**
   * Завершение работы. Раньше выгружала локальные модели Ollama — теперь no-op
   * (модели облачные, локальных ресурсов не остаётся).
   */
  async cleanup() {
    /* no-op */
  }
}
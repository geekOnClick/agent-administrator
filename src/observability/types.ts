import { BillCategory } from '../llm/prompts.js';

/**
 * Типы подсистемы observability для мода bills.
 *
 * BillsRunReport — детерминированный отчёт о полном запуске цикла
 * (bills → [retry…] → continue/continue!): какие шаги выполнялись, сколько
 * раз, сколько стоило, и какие метрики успеха выполнены/провалены в конце.
 * Отчёт пишется одной строкой JSON в data/observability/bills-runs.jsonl.
 */

/**
 * Статистика считывания таблицы учёта — собирается при каждом readLedgerRows
 * и при валидации сумм из LLM-ответа.
 */
export interface TableReadStats {
  /** Всего строк прочитано из docx (без заголовка). */
  totalRows: number;
  /** Строки, у которых не удалось распознать месяц (пустая ячейка или нераспознанный формат). */
  skippedInvalidMonth: number;
  /** Ячейки с суммами, где parseAmount вернул null или NaN. */
  skippedInvalidAmount: number;
  /** Строки данных, у которых ни одна сумма не распознана (возможно, пустые). */
  emptyAmountRows: number;
  /** Строки, успешно разобранные и добавленные в результат. */
  parsedRows: number;
}

/** Идентификаторы отслеживаемых шагов цикла bills. */
export type BillsStepId =
  | 'downloadDocs'
  | 'validateCategories'
  | 'organizeBills'
  | 'appendLedgerRow'
  | 'syncVectorStore'
  | 'cleanupManifests'
  | 'checkReceipts'
  | 'generateSordisu';

/** Статус шага в рамках запуска. */
export type BillsStepStatus = 'ok' | 'failed' | 'skipped';

export interface BillsStepMetrics {
  status: BillsStepStatus;
  /** Сколько раз шаг выполнялся (retry повторяет шаги 1-3 и 7). */
  attempts: number;
  /** Последняя ошибка шага (для failed/skipped-by-error). */
  lastError?: string;
  /** Суммарное время выполнения шага по всем попыткам, мс. */
  totalDurationMs: number;
}

/** Результат проверки одной метрики успеха в конце запуска. */
export interface SuccessMetricResult {
  id: string;
  title: string;
  ok: boolean;
  /** Пояснение: почему метрика выполнена или провалена. */
  detail: string;
}

/** Снимок потребления RouterAI на момент (для дельты стоимости запуска). */
export interface UsageSnapshot {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costRub: number;
}

/** Дельта стоимости/токенов за весь запуск bills. */
export interface BillsRunCost {
  routerAIRequests: number;
  promptTokens: number;
  completionTokens: number;
  costRub: number;
}

export interface BillsRunReport {
  /** Уникальный id запуска цикла bills. */
  runId: string;
  /** Время старта команды bills (ISO). */
  startedAt: string;
  /** Время завершения цикла (ISO) — успешного или финально неуспешного. */
  finishedAt: string;
  durationMs: number;
  /** Число итераций валидации (bills + каждый retry). */
  validationAttempts: number;
  /** Число итераций продолжения (continue / continue!). */
  continueAttempts: number;
  /** Чем закончился запуск: полный успех / успех с исключениями (continue!) / провал. */
  outcome: 'success' | 'successForced' | 'failed';
  /** Категории, исключённые из счёта при continue!. */
  excludedCategories: BillCategory[];
  /** Метрики по шагам цикла. */
  steps: Record<BillsStepId, BillsStepMetrics>;
  /** Покрытые/пропущенные категории по последней валидации. */
  coveredCategories: BillCategory[];
  missingCategories: BillCategory[];
  /** Стоимость и токены RouterAI за запуск. */
  cost: BillsRunCost;
  /** Метрики успеха, проверенные после окончания работы мода bills. */
  successMetrics: SuccessMetricResult[];
  /** Итог: все ли метрики успеха выполнены. */
  allSuccessMetricsPassed: boolean;
  /** Статистика считывания таблицы учёта за этот запуск (опционально — появляется после syncVectorStore). */
  tableReadStats?: TableReadStats;
}

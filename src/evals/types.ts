import { AgentTask } from '../llm/routing/model-router.js';

/**
 * Типы подсистемы оценки качества агента (evals).
 *
 * Gold-кейс описывает один прогон команды агента (ask/askMeters) с эталонными
 * ожиданиями. Проверка успеха детерминированная (без LLM-as-judge): ответ модели
 * сверяется с mustContainAny/mustNotContain/refusal, поэтому прогоны
 * воспроизводимы и не тратят деньги на модель-судью.
 */

/** Способ проверки успеха ответа. */
export type GoldExpectKind =
  /** Ответ должен содержать эталонные факты (mustContainAny). */
  | 'answer'
  /** Ответ должен честно сообщить об отсутствии данных (refusal), а не выдумывать факты. */
  | 'refusal'
  /** Prompt-injection: ответ не должен содержать маркер срабатывания инъекции (mustNotContain). */
  | 'injection';

export interface GoldCase {
  id: string;
  /** Команда агента, которую выполняет кейс. */
  task: Extract<AgentTask, 'ask' | 'askMeters'>;
  /** Вопрос пользователя, как его ввели бы в CLI. */
  question: string;
  expect: GoldExpectKind;
  /**
   * Группы эталонных фраз. Ответ успешен, если в каждой группе найдена
   * хотя бы одна фраза (регистронезависимо). Для refusal/injection не используется.
   */
  mustContainAny?: string[][];
  /** Маркеры отказа ("данных не найдено" и т.п.): для refusal достаточно одного. */
  refusal?: string[];
  /** Запрещённые маркеры (инъекции, заготовленный "вредоносный" вывод). */
  mustNotContain?: string[];
  /** Категории фактов, которые нельзя выдумывать при отказе (антил-галлюцинация). */
  mustNotFabricate?: Array<'amount' | 'month' | 'reading' | 'date'>;
  /** Верхняя граница латентности, мс. Превышение — провал метрики времени. */
  maxLatencyMs?: number;
}

export interface GoldSet {
  version: number;
  description?: string;
  cases: GoldCase[];
}

/** Метрики одного кейса после прогона. */
export interface CaseMetrics {
  success: boolean;
  /** Время полного ответа агента (поиск контекста + генерация), мс. */
  latencyMs: number;
  /** Стоимость ответа, руб. Для ask/askMeters (локальная Ollama) — 0. */
  costRub: number;
  promptTokens: number | null;
  completionTokens: number | null;
  failures: string[];
}

export interface EvalCaseResult extends CaseMetrics {
  id: string;
  task: GoldCase['task'];
  expect: GoldExpectKind;
  question: string;
  answer: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  /** Доля успешных кейсов (0..1). */
  successRate: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  p95LatencyMs: number;
  /** Суммарная стоимость прогона, руб. */
  totalCostRub: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export interface EvalReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  model: string;
  goldSetVersion: number;
  summary: EvalSummary;
  results: EvalCaseResult[];
}

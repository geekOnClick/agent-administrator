import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRouterAIUsageStats } from '../services/RouterAIService.js';
import type { BillCategory } from '../llm/prompts.js';
import type {
  BillsRunReport,
  BillsRunCost,
  BillsStepId,
  BillsStepMetrics,
  BillsStepStatus,
  SuccessMetricResult,
  UsageSnapshot
} from './types.js';

/** Порог стоимости одного запуска bills (руб.): превышение — провал метрики SM-6. */
const MAX_COST_RUB_PER_RUN = Number(process.env.BILLS_MAX_COST_RUB ?? '5');

const JSONL_PATH = path.resolve(process.cwd(), 'data', 'observability', 'bills-runs.jsonl');

// ---------------------------------------------------------------------------
// Внутренний черновик шага
// ---------------------------------------------------------------------------
interface StepDraft {
  startedAt: number;
  attempts: number;
  totalDurationMs: number;
  status: BillsStepStatus;
  lastError?: string;
}

function emptyStep(): StepDraft {
  return { startedAt: 0, attempts: 0, totalDurationMs: 0, status: 'skipped' };
}

// ---------------------------------------------------------------------------
// Трекер одного запуска мода bills
// ---------------------------------------------------------------------------

/**
 * Отслеживает один полный запуск цикла bills (bills → [retry…] → continue/continue!):
 * - замеряет время каждого шага и число попыток;
 * - вычисляет дельту стоимости RouterAI относительно снимка до старта;
 * - в конце оценивает метрики успеха и пишет отчёт в JSONL.
 *
 * Жизненный цикл:
 *   const tracker = BillsRunTracker.create();
 *   const end = tracker.beginStep('downloadDocs');  end();   // ok
 *   tracker.failStep('validateCategories', 'timeout');       // error
 *   tracker.skipStep('generateSordisu');                     // пропущен
 *   const report = tracker.finish('success');                // → пишет JSONL
 */
export class BillsRunTracker {
  private readonly runId: string;
  private readonly startedAt: Date;
  private readonly usageAtStart: UsageSnapshot;

  private validationAttempts = 0;
  private continueAttempts = 0;
  private coveredCategories: BillCategory[] = [];
  private missingCategories: BillCategory[] = [];
  private excludedCategories: BillCategory[] = [];

  private readonly steps: Record<BillsStepId, StepDraft> = {
    downloadDocs: emptyStep(),
    validateCategories: emptyStep(),
    organizeBills: emptyStep(),
    appendLedgerRow: emptyStep(),
    syncVectorStore: emptyStep(),
    cleanupManifests: emptyStep(),
    checkReceipts: emptyStep(),
    generateSordisu: emptyStep()
  };

  private constructor() {
    this.runId = randomUUID();
    this.startedAt = new Date();
    const s = getRouterAIUsageStats();
    this.usageAtStart = {
      requests: s.requests,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      costRub: s.costRub
    };
  }

  /** Создаёт новый трекер, фиксируя снимок статистики RouterAI перед стартом. */
  static create(): BillsRunTracker {
    return new BillsRunTracker();
  }

  // ---------------------------------------------------------------------------
  // Управление шагами
  // ---------------------------------------------------------------------------

  /**
   * Отмечает начало шага; возвращает функцию-финализатор (вызвать после шага).
   * Можно вызывать несколько раз для одного шага (retry): каждый вызов = новая попытка.
   *
   * @example
   *   const end = tracker.beginStep('downloadDocs');
   *   try { ... } finally { end(); }
   */
  beginStep(step: BillsStepId): () => void {
    const draft = this.steps[step];
    draft.startedAt = Date.now();
    draft.attempts += 1;
    draft.status = 'ok'; // предполагаем успех; failStep перезапишет
    return () => {
      draft.totalDurationMs += Date.now() - draft.startedAt;
    };
  }

  /** Помечает шаг как упавший с ошибкой (вызывать из catch-блока). */
  failStep(step: BillsStepId, error: string): void {
    const draft = this.steps[step];
    draft.totalDurationMs += Date.now() - draft.startedAt;
    draft.status = 'failed';
    draft.lastError = error;
  }

  /** Помечает шаг как пропущенный (условная ветка не выполнялась). */
  skipStep(step: BillsStepId, reason?: string): void {
    const draft = this.steps[step];
    draft.status = 'skipped';
    if (reason) draft.lastError = reason;
  }

  // ---------------------------------------------------------------------------
  // Накопление данных цикла
  // ---------------------------------------------------------------------------

  incValidationAttempts(): void {
    this.validationAttempts += 1;
  }

  incContinueAttempts(): void {
    this.continueAttempts += 1;
  }

  setCoveredCategories(covered: BillCategory[], missing: BillCategory[]): void {
    this.coveredCategories = covered;
    this.missingCategories = missing;
  }

  setExcludedCategories(cats: BillCategory[]): void {
    this.excludedCategories = cats;
  }

  // ---------------------------------------------------------------------------
  // Финализация
  // ---------------------------------------------------------------------------

  /**
   * Завершает трекер: оценивает метрики успеха, записывает отчёт в JSONL и
   * выводит сводку в консоль. Возвращает готовый BillsRunReport.
   */
  finish(outcome: BillsRunReport['outcome']): BillsRunReport {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - this.startedAt.getTime();

    // Дельта стоимости за запуск
    const sNow = getRouterAIUsageStats();
    const cost: BillsRunCost = {
      routerAIRequests: sNow.requests - this.usageAtStart.requests,
      promptTokens: sNow.promptTokens - this.usageAtStart.promptTokens,
      completionTokens: sNow.completionTokens - this.usageAtStart.completionTokens,
      costRub: sNow.costRub - this.usageAtStart.costRub
    };

    // Шаги → финальный вид
    const steps = {} as Record<BillsStepId, BillsStepMetrics>;
    for (const [id, draft] of Object.entries(this.steps) as [BillsStepId, StepDraft][]) {
      steps[id] = {
        status: draft.attempts === 0 ? 'skipped' : draft.status,
        attempts: draft.attempts,
        totalDurationMs: draft.totalDurationMs,
        ...(draft.lastError ? { lastError: draft.lastError } : {})
      };
    }

    // Метрики успеха
    const successMetrics = evaluateBillsSuccessMetrics({
      outcome,
      steps,
      coveredCategories: this.coveredCategories,
      missingCategories: this.missingCategories,
      excludedCategories: this.excludedCategories,
      cost
    });
    const allSuccessMetricsPassed = successMetrics.every((m) => m.ok);

    const report: BillsRunReport = {
      runId: this.runId,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      validationAttempts: this.validationAttempts,
      continueAttempts: this.continueAttempts,
      outcome,
      excludedCategories: this.excludedCategories,
      steps,
      coveredCategories: this.coveredCategories,
      missingCategories: this.missingCategories,
      cost,
      successMetrics,
      allSuccessMetricsPassed
    };

    writeRunReport(report);
    printSuccessMetricsReport(report);

    return report;
  }
}

// ---------------------------------------------------------------------------
// Оценка метрик успеха
// ---------------------------------------------------------------------------

interface MetricInput {
  outcome: BillsRunReport['outcome'];
  steps: Record<BillsStepId, BillsStepMetrics>;
  coveredCategories: BillCategory[];
  missingCategories: BillCategory[];
  excludedCategories: BillCategory[];
  cost: BillsRunCost;
}

/**
 * Шесть детерминированных метрик успеха запуска мода bills.
 * Проверяются после завершения цикла (независимо от outcome).
 */
function evaluateBillsSuccessMetrics(input: MetricInput): SuccessMetricResult[] {
  const { outcome, steps, missingCategories, excludedCategories, cost } = input;

  const results: SuccessMetricResult[] = [];

  // SM-1: Все категории счетов покрыты
  {
    const ok = missingCategories.length === 0;
    results.push({
      id: 'SM-1',
      title: 'Все категории счетов покрыты',
      ok,
      detail: ok
        ? `Покрыто ${input.coveredCategories.length} категорий`
        : `Не хватает категорий (${missingCategories.length}): ${missingCategories.join(', ')}`
    });
  }

  // SM-2: Квитанции об оплате найдены во всех папках (без исключений)
  {
    const ok = outcome !== 'failed' && excludedCategories.length === 0;
    const detail = outcome === 'failed'
      ? 'Цикл завершился с ошибкой — проверка квитанций не завершена'
      : excludedCategories.length > 0
        ? `Форсированное продолжение: исключены категории без квитанции (${excludedCategories.join(', ')})`
        : 'Квитанции найдены во всех папках';
    results.push({ id: 'SM-2', title: 'Квитанции найдены во всех папках', ok, detail });
  }

  // SM-3: Счёт «Сордису» успешно сгенерирован
  {
    const s = steps.generateSordisu;
    const ok = s.status === 'ok';
    const detail = ok
      ? `Сгенерирован за ${s.totalDurationMs} мс`
      : s.status === 'skipped'
        ? 'Шаг не выполнялся (цикл не дошёл до generate_sordisu)'
        : `Ошибка генерации: ${s.lastError ?? 'неизвестно'}`;
    results.push({ id: 'SM-3', title: 'Счёт «Сордису» сгенерирован', ok, detail });
  }

  // SM-4: Таблица учёта коммунальных платежей обновлена
  {
    const s = steps.appendLedgerRow;
    const ok = s.status === 'ok';
    const detail = ok
      ? `Строка добавлена за ${s.totalDurationMs} мс`
      : s.status === 'skipped'
        ? 'Шаг не выполнялся'
        : `Ошибка записи в таблицу: ${s.lastError ?? 'неизвестно'}`;
    results.push({ id: 'SM-4', title: 'Таблица учёта коммунальных платежей обновлена', ok, detail });
  }

  // SM-5: Векторная база синхронизирована с таблицей учёта
  {
    const s = steps.syncVectorStore;
    const ok = s.status === 'ok';
    const detail = ok
      ? `Синхронизировано за ${s.totalDurationMs} мс`
      : s.status === 'skipped'
        ? 'Шаг не выполнялся'
        : `Ошибка синхронизации: ${s.lastError ?? 'неизвестно'}`;
    results.push({ id: 'SM-5', title: 'Векторная база синхронизирована', ok, detail });
  }

  // SM-6: Стоимость запуска не превышает порог
  {
    const ok = cost.costRub <= MAX_COST_RUB_PER_RUN;
    const detail = ok
      ? `${cost.costRub.toFixed(4)} руб. (порог: ${MAX_COST_RUB_PER_RUN} руб.)`
      : `${cost.costRub.toFixed(4)} руб. превышает порог ${MAX_COST_RUB_PER_RUN} руб.`;
    results.push({ id: 'SM-6', title: `Стоимость запуска ≤ ${MAX_COST_RUB_PER_RUN} руб.`, ok, detail });
  }

  return results;
}

// ---------------------------------------------------------------------------
// JSONL-запись
// ---------------------------------------------------------------------------

function writeRunReport(report: BillsRunReport): void {
  try {
    const dir = path.dirname(JSONL_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(JSONL_PATH, JSON.stringify(report) + '\n', 'utf8');
  } catch (err) {
    console.error(`[observability] Не удалось записать отчёт в ${JSONL_PATH}:`, err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Печать финального отчёта в консоль
// ---------------------------------------------------------------------------

function printSuccessMetricsReport(report: BillsRunReport): void {
  const { successMetrics, allSuccessMetricsPassed, cost, durationMs, runId } = report;

  console.log('\n' + '═'.repeat(60));
  console.log('📊 ОТЧЁТ О КАЧЕСТВЕ ЗАПУСКА (observability)');
  console.log('═'.repeat(60));
  console.log(`  Запуск:    ${runId}`);
  console.log(`  Итог:      ${formatOutcome(report.outcome)}`);
  console.log(`  Время:     ${(durationMs / 1000).toFixed(1)} с`);
  console.log(`  Стоимость: ${cost.costRub.toFixed(4)} руб. | запросов: ${cost.routerAIRequests} | токены: ${cost.promptTokens} вх. / ${cost.completionTokens} вых.`);
  console.log('');
  console.log('  Метрики успеха:');
  for (const m of successMetrics) {
    const icon = m.ok ? '✅' : '❌';
    console.log(`    ${icon} [${m.id}] ${m.title}`);
    console.log(`         ${m.detail}`);
  }
  console.log('');
  if (allSuccessMetricsPassed) {
    console.log('  ✅ Все метрики успеха выполнены.');
  } else {
    const failed = successMetrics.filter((m) => !m.ok).map((m) => m.id).join(', ');
    console.log(`  ❌ Метрики НЕ выполнены: ${failed}`);
  }
  console.log(`  Отчёт сохранён: ${JSONL_PATH}`);
  console.log('═'.repeat(60) + '\n');
}

function formatOutcome(outcome: BillsRunReport['outcome']): string {
  switch (outcome) {
    case 'success': return '✅ success (полный успех)';
    case 'successForced': return '⚠️  successForced (continue! — без части квитанций)';
    case 'failed': return '❌ failed';
  }
}

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChatProcessor } from '../llm/chat-processor.js';
import { config } from '../config.js';
import { buildCaseMetrics, percentile95 } from './metrics.js';
import { EvalCaseResult, EvalReport, EvalSummary, GoldCase, GoldSet } from './types.js';

/**
 * Раннер оценки качества агента (evals).
 *
 * Прогоняет gold set через реальные пути агента (ask/askMeters: векторный поиск
 * в FalkorDB + локальная модель Ollama) и считает три метрики по каждому кейсу:
 *   — успех: детерминированная сверка ответа с эталоном (см. metrics.ts);
 *   — время: полная латентность ответа, мс;
 *   — стоимость: руб. за ответ (ask/askMeters выполняет локальная модель → 0 руб.;
 *     тарифы RouterAI для документных задач задаются в .env, см. config.routerAIPricing).
 *
 * Запуск: npm run evals [-- --out data/evals/report.json]
 * Требования: запущенные Ollama и FalkorDB, актуализированная векторная база.
 */

interface RunnerOptions {
  goldSetPath: string;
  outPath: string | null;
  caseIds: Set<string> | null;
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    goldSetPath: path.resolve(process.cwd(), 'src/evals/gold-set.json'),
    outPath: null,
    caseIds: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--gold-set' && argv[i + 1]) {
      options.goldSetPath = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === '--out' && argv[i + 1]) {
      options.outPath = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === '--case' && argv[i + 1]) {
      options.caseIds = options.caseIds ?? new Set();
      options.caseIds.add(argv[++i]);
    }
  }

  return options;
}

function loadGoldSet(goldSetPath: string): GoldSet {
  const raw = fs.readFileSync(goldSetPath, 'utf-8');
  const parsed = JSON.parse(raw) as GoldSet;
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`Gold set пуст или некорректен: ${goldSetPath}`);
  }
  return parsed;
}

async function runCase(processor: ChatProcessor, testCase: GoldCase): Promise<EvalCaseResult> {
  const sessionId = `eval-${testCase.id}`;
  const startedAt = performance.now();

  let answer: string;
  try {
    answer =
      testCase.task === 'ask'
        ? await processor.askAboutLedger(sessionId, testCase.question)
        : await processor.askAboutMeters(sessionId, testCase.question);
  } catch (err) {
    answer = `⛔ Ошибка выполнения: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await processor.resetSession(sessionId);
  }

  const latencyMs = performance.now() - startedAt;

  // ask/askMeters обслуживает локальная Ollama (EASY-режим) — прямой стоимости нет.
  const metrics = buildCaseMetrics(testCase, answer, latencyMs, {
    costRub: 0,
    promptTokens: null,
    completionTokens: null
  });

  return {
    id: testCase.id,
    task: testCase.task,
    expect: testCase.expect,
    question: testCase.question,
    answer,
    ...metrics
  };
}

function buildSummary(results: EvalCaseResult[]): EvalSummary {
  const passed = results.filter((r) => r.success).length;
  const latencies = results.map((r) => r.latencyMs);

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    successRate: results.length > 0 ? passed / results.length : 0,
    avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    p95LatencyMs: percentile95(latencies),
    totalCostRub: results.reduce((acc, r) => acc + r.costRub, 0),
    totalPromptTokens: results.reduce((acc, r) => acc + (r.promptTokens ?? 0), 0),
    totalCompletionTokens: results.reduce((acc, r) => acc + (r.completionTokens ?? 0), 0)
  };
}

function printReport(report: EvalReport): void {
  const { summary } = report;
  console.log('\n════════ ОТЧЁТ EVALS ════════');
  console.log(`Модель: ${report.model} | gold set v${report.goldSetVersion} | длительность: ${(report.durationMs / 1000).toFixed(1)} с`);
  console.log(
    `Успех: ${summary.passed}/${summary.total} (${(summary.successRate * 100).toFixed(1)}%) | ` +
      `время: avg ${(summary.avgLatencyMs / 1000).toFixed(1)} с, p95 ${(summary.p95LatencyMs / 1000).toFixed(1)} с, max ${(summary.maxLatencyMs / 1000).toFixed(1)} с | ` +
      `стоимость: ${summary.totalCostRub.toFixed(4)} руб.`
  );

  for (const result of report.results) {
    const mark = result.success ? '✅' : '⛔';
    console.log(`\n${mark} [${result.id}] (${(result.latencyMs / 1000).toFixed(1)} с, ${result.costRub.toFixed(4)} руб.)`);
    console.log(`   Вопрос: ${result.question}`);
    if (!result.success) {
      for (const failure of result.failures) {
        console.log(`   ⚠️ ${failure}`);
      }
      console.log(`   Ответ: ${result.answer.slice(0, 300)}`);
    }
  }
}

export async function runEvals(options: RunnerOptions): Promise<EvalReport> {
  const goldSet = loadGoldSet(options.goldSetPath);
  const cases = options.caseIds ? goldSet.cases.filter((c) => options.caseIds!.has(c.id)) : goldSet.cases;
  if (cases.length === 0) {
    throw new Error('Ни один кейс gold set не выбран для прогона.');
  }

  console.log(`▶️  Evals: ${cases.length} кейсов из ${path.basename(options.goldSetPath)} (модель ${config.ollama.model})`);

  const processor = new ChatProcessor();
  const startedAt = new Date();
  const startMs = performance.now();
  const results: EvalCaseResult[] = [];

  try {
    await processor.init();
    for (const testCase of cases) {
      process.stdout.write(`… ${testCase.id} `);
      const result = await runCase(processor, testCase);
      results.push(result);
      console.log(result.success ? 'OK' : 'FAIL');
    }
  } finally {
    await processor.cleanup();
  }

  const report: EvalReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - startMs,
    model: config.ollama.model,
    goldSetVersion: goldSet.version,
    summary: buildSummary(results),
    results
  };

  printReport(report);

  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n💾 Отчёт сохранён: ${options.outPath}`);
  }

  return report;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  runEvals(options)
    .then((report) => process.exit(report.summary.failed > 0 ? 1 : 0))
    .catch((err) => {
      console.error(`⛔ Evals не выполнены: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}

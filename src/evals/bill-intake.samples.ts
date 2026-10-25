/**
 * Интеграционный тест детерминированного intake счетов через agentModelRouter
 * на реальных образцах из docs/. Запуск: npx tsx src/evals/bill-intake.samples.ts
 *
 * Проверяет: классификация категории + итоговая сумма по каждому файлу,
 * агрегация по категориям с дедупликацией одинаковых итогов (heat: реестр + счёт-фактура).
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { agentModelRouter } from '../llm/routing/model-router.js';
import type { BillCategory } from '../llm/prompts.js';

interface ExpectedCat {
  key: string;
  files: string[];
  // Дедуплицированная сумма итогов по категории (сумма различных итогов).
  total: number;
}

const EXPECTED: ExpectedCat[] = [
  { key: 'electricity', files: ['УПД'], total: 18180.51 },
  { key: 'heat', files: ['Реестр-1292', 'СчетФактура-1292'], total: 2354.66 },
  { key: 'water', files: ['водоканал1', 'водоканал2'], total: 289.98 },
  { key: 'garbage', files: ['00БП-084756'], total: 1264.46 },
  { key: 'maintenance', files: ['7605'], total: 2930.47 }
];

const eq = (a: number | null | undefined, b: number, eps = 0.01) =>
  a !== null && a !== undefined && Math.abs(a - b) < eps;

async function main() {
  const docsDir = path.resolve(process.cwd(), 'docs');
  const all = fs.readdirSync(docsDir);
  const filePaths = all
    .filter((f) => /\.(pdf|xls|xlsx|doc|docx|odt)$/i.test(f))
    .map((f) => path.join(docsDir, f));

  console.log(`Документов: ${filePaths.length}\n`);
  const res = await agentModelRouter.validateBillCategories(filePaths);

  let pass = 0;
  let fail = 0;

  console.log('Детали по файлам:');
  for (const d of res.details) {
    const amt = typeof d.amount === 'number' ? d.amount.toFixed(2) : 'NULL';
    console.log(`  • ${d.file}: [${d.category ?? '—'}] ${amt} руб.${d.issue ? `  ⚠️ ${d.issue}` : ''}`);
  }

  console.log('\nАгрегация по категориям (с дедупликацией одинаковых итогов):');
  for (const exp of EXPECTED) {
    const catDetails = res.details.filter((d) => d.category === exp.key);
    const seen = new Set<number>();
    let sum = 0;
    let counted = 0;
    for (const d of catDetails) {
      if (typeof d.amount !== 'number') continue;
      const k = Math.round(d.amount * 100);
      if (seen.has(k)) continue;
      seen.add(k);
      sum += d.amount;
      counted += 1;
    }
    const okCat = catDetails.length === exp.files.length;
    const okSum = eq(sum, exp.total);
    const ok = okCat && okSum;
    if (ok) pass++;
    else fail++;
    console.log(
      `  ${ok ? '✅' : '❌'} [${exp.key}] файлов ${catDetails.length}/${exp.files.length}, сумма ${sum?.toFixed(2) ?? 'NULL'} (ож. ${exp.total}), уникальных ${counted}`
    );
  }

  console.log('\nПокрытие категорий:');
  console.log(`  covered:  ${res.coveredCategories.join(', ') || '—'}`);
  console.log(`  missing:  ${res.missingCategories.join(', ') || '—'}`);
  console.log(`  valid:    ${res.valid}`);
  if (res.errors.length) {
    console.log('  errors:');
    for (const e of res.errors) console.log(`    - ${e}`);
  }

  const allCovered = res.missingCategories.length === 0;
  console.log('\n' + '─'.repeat(60));
  console.log(`Категории покрыты: ${allCovered ? '✅' : '❌'}  | Тестов пройдено: ✅ ${pass} ❌ ${fail}`);
  process.exit(allCovered && fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
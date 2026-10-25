/**
 * Тест детерминированного парсера итогов на реальных образцах счетов из docs/.
 * Запуск: npx tsx src/evals/bill-totals.samples.ts
 *
 * Ожидаемые итоги к оплате по категориям (июль 2026):
 *   electricity  — УПД-УКД (1292\1\1)            → 18 180,51
 *   heat         — Реестр XLS + СчетФактура PDF  → 2 354,66  (один счёт в 2 файлах)
 *   water        — водоканал1 + водоканал2        → 56,84 + 233,14 = 289,98
 *   garbage      — Счет к Р. 00БП (Нижэкология)   → 1 264,46  (без НДС)
 *   maintenance  — Счет № 7605 (Наш Дом)          → 2 930,47
 */
import path from 'node:path';
import fs from 'node:fs';
import { documentTextService } from '../services/document-text/DocumentTextService.js';
import { parseBillTotals, type BillTotals } from '../services/bill-totals/BillTotalsParser.js';

interface Expected {
  file: string;
  total: number;
  subtotal?: number;
  vat?: number;
  category: string;
}

const EXPECTED: Expected[] = [
  { file: 'УПД', total: 18180.51, subtotal: 14902.06, vat: 3278.45, category: 'electricity' },
  { file: 'Реестр-1292', total: 2354.66, subtotal: 1930.05, vat: 424.61, category: 'heat' },
  { file: 'СчетФактура-1292', total: 2354.66, subtotal: 1930.05, vat: 424.61, category: 'heat' },
  { file: 'водоканал1', total: 56.84, subtotal: 46.59, vat: 10.25, category: 'water' },
  { file: 'водоканал2', total: 233.14, subtotal: 191.1, vat: 42.04, category: 'water' },
  { file: '00БП-084756', total: 1264.46, subtotal: 1264.46, vat: 0, category: 'garbage' },
  { file: '7605', total: 2930.47, subtotal: 2402.02, vat: 528.45, category: 'maintenance' }
];

const eq = (a: number | null | undefined, b: number, eps = 0.01) =>
  a !== null && a !== undefined && Math.abs(a - b) < eps;

async function main() {
  const docsDir = path.resolve(process.cwd(), 'docs');
  let pass = 0;
  let fail = 0;

  for (const exp of EXPECTED) {
    // Файлы с не-ASCII символами (№, nbsp) — находим по подстроке-ключу.
    const all = fs.readdirSync(docsDir);
    const found = all.find((f) => f.includes(exp.file));
    const fp = found ? path.join(docsDir, found) : path.join(docsDir, exp.file);
    if (!fs.existsSync(fp)) {
      console.log(`⚠️  ФАЙЛ НЕ НАЙДЕН: ${exp.file}`);
      fail++;
      continue;
    }
    const doc = await documentTextService.extract(fp);
    const totals: BillTotals | null = doc.kind === 'text' ? parseBillTotals(doc.text) : null;
    const t = totals?.totalWithVat ?? null;
    const st = totals?.subtotal ?? null;
    const va = totals?.vatAmount ?? null;
    const okTotal = eq(t, exp.total);
    const okSub = exp.subtotal === undefined || eq(st, exp.subtotal);
    const okVat = exp.vat === undefined || eq(va, exp.vat);
    const ok = okTotal && okSub && okVat && doc.kind === 'text';
    if (ok) pass++;
    else fail++;
    console.log(
      `${ok ? '✅' : '❌'} [${exp.category}] ${found ?? exp.file}\n` +
        `     kind=${doc.kind}  total=${t} (ож. ${exp.total})  subtotal=${st} (ож. ${exp.subtotal})  vat=${va} (ож. ${exp.vat})` +
        (totals?.unit ? `  unit=${totals.unit}` : '') +
        (totals?.issue ? `  ⚠️ ${totals.issue}` : '') +
        '\n'
    );
  }

  console.log('─'.repeat(60));
  console.log(`Итого: ✅ ${pass}  ❌ ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
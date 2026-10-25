/**
 * Детерминированный парсер итоговой суммы по счёту.
 *
 * Почему не LLM: модель регулярно путает колонки («Итого» vs «Всего к оплате» vs
 * «Итого с НДС»), берёт не ту сумму в многострочных счёт-фактурах/УПД и теряет
 * числа в составных ценах вида «31,06*0,5». Все эти подписи в российских счетах
 * детерминированы по тексту — поэтому итог распознаём регулярками по извлечённому
 * из документа тексту (pdftotext -layout для PDF, CSV из LibreOffice для XLS).
 *
 * Поддержанные образцы подписей (по реальным счетам проекта):
 *   - Реестр/счёт тепло (XLS): «Итого: 1 930,05» / «НДС: 424,61» / «Итого с НДС: 2 354,66»
 *   - УПД/счёт-фактура (PDF, много колонок в строке «Всего к оплате (9)»):
 *       «14 902,06 без акциза  22%  3 278,45  18 180,51» → итог = последнее число строки
 *   - Водоканал (PDF): «Итого: 46,59» / «Сумма НДС: 10,25» / «Всего к оплате: 56,84»
 *   - Нижэкология (PDF, без НДС): «Итого: 1 264,46» / «Без налога (НДС): -» / «Всего к оплате: 1 264,46»
 *   - Наш Дом (PDF): «Итого: 2 402,02» / «Сумма НДС 22%: 528,45» / «Всего к оплате: 2 930,47»
 */

export interface BillTotals {
  /** Сумма без НДС («Итого» / «без акциза»). */
  subtotal: number | null;
  /** Ставка НДС, % (0 — если «Без налога»). */
  vatPercent: number | null;
  /** Сумма НДС в рублях. */
  vatAmount: number | null;
  /** Итого к оплате с учётом НДС — главная сумма по счёту. */
  totalWithVat: number | null;
  /** Единица измерения (best-effort: Гкал, кВт.ч, м3, м2). */
  unit: string | null;
  /** Количество (best-effort). */
  quantity: number | null;
  /** Цена за единицу (best-effort). */
  pricePerUnit: number | null;
  /** Причина, если итог не удалось определить. */
  issue: string | null;
}

/** Нормализация русского числа («1 930,05» / «0,7682» / «22») → number. */
export function parseRuNumber(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s+/g, '').replace(',', '.');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

/**
 * Извлекает все числа из строки текста в порядке появления.
 * Понимает тысячные разделители пробелом («18 180,51») и запятую как десятичный
 * разделитель («56,84»). Даты/телефоны с точками/дефисами не матчатся.
 */
export function extractNumbers(line: string): number[] {
  const re = /\d{1,3}(?:\s\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const v = parseRuNumber(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}

const UNIT_KEYWORDS: Array<[RegExp, string]> = [
  [/кВт\.?ч|квт\.?ч/i, 'кВт.ч'],
  [/гкал/i, 'Гкал'],
  [/м3|м³|куб\./i, 'м3'],
  [/м2|м²|кв\.?м/i, 'м2']
];

function detectUnit(text: string): string | null {
  for (const [re, unit] of UNIT_KEYWORDS) {
    if (re.test(text)) return unit;
  }
  return null;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** Первая непустая строка, начиная с idx, содержащая ≥ minNumbers чисел. */
function firstLineWithNumbers(lines: string[], fromIdx: number, minNumbers = 2, maxLookahead = 12): { line: string; idx: number } | null {
  for (let i = fromIdx; i < Math.min(lines.length, fromIdx + maxLookahead); i++) {
    if (extractNumbers(lines[i]).length >= minNumbers) return { line: lines[i], idx: i };
  }
  return null;
}

/**
 * Распознаёт итоги счёта по извлечённому из документа тексту.
 * Возвращает BillTotals с totalWithVat===null и issue, если итог не найден.
 */
export function parseBillTotals(text: string): BillTotals {
  const empty: BillTotals = {
    subtotal: null,
    vatPercent: null,
    vatAmount: null,
    totalWithVat: null,
    unit: null,
    quantity: null,
    pricePerUnit: null,
    issue: 'итоговая сумма не распознана'
  };
  if (!text || !text.trim()) return empty;

  const lines = splitLines(text);

  // --- ИТОГ К ОПЛАТЕ (totalWithVat) ---
  let totalWithVat: number | null = null;

  // 1) «Итого с НДС: …» (реестры) — самое строгое/однозначное.
  for (const line of lines) {
    if (/Итого\s+с\s*НДС/i.test(line)) {
      const nums = extractNumbers(line);
      if (nums.length > 0) {
        totalWithVat = nums[nums.length - 1];
        break;
      }
    }
  }

  // 2) «Всего к оплате …» — основная подпись в счетах.
  if (totalWithVat === null) {
    for (let i = 0; i < lines.length; i++) {
      if (!/Всего\s+к\s+оплате/i.test(lines[i])) continue;
      // Вырезаем метки-индексы колонок вида «(9)», чтобы не принять их за сумму.
      const cleaned = lines[i].replace(/\(\s*\d+\s*\)/g, '');
      const nums = extractNumbers(cleaned);
      if (nums.length > 0) {
        totalWithVat = nums[nums.length - 1];
        break;
      }
      // Метка-строка без чисел — итог в ближайшей ниже строке с ≥2 числами
      // (строка данных счёт-фактуры: «1 930,05 без акциза 22% 424,61 2 354,66»).
      const ahead = firstLineWithNumbers(lines, i + 1, 2, 12);
      if (ahead) {
        const aheadNums = extractNumbers(ahead.line);
        if (aheadNums.length > 0) {
          totalWithVat = aheadNums[aheadNums.length - 1];
          break;
        }
      }
    }
  }

  if (totalWithVat === null) {
    // 3) Счёт-фактура/УПД: «… без акциза … 22% … 424,61 … 2 354,66» —
    //    итог = последнее число строки данных (колонка «с налогом всего»).
    for (const line of lines) {
      if (!/без\s*акциза/i.test(line)) continue;
      const nums = extractNumbers(line);
      if (nums.length >= 2) {
        totalWithVat = nums[nums.length - 1];
        break;
      }
    }
  }

  if (totalWithVat === null) return empty;

  // --- СУММА БЕЗ НДС (subtotal) ---
  let subtotal: number | null = null;

  // 1) «… без акциза» — сумма без НДС в счёт-фактурах/УПД (число прямо перед подписью).
  for (const line of lines) {
    const m = line.match(/(\d{1,3}(?:\s\d{3})+(?:,\d+)?|\d+(?:,\d+)?)\s*без\s*акциза/i);
    if (m) {
      subtotal = parseRuNumber(m[1]);
      if (subtotal !== null) break;
    }
  }

  // 2) «Итого: …» (plain, не «Итого с НДС») — обычные счета.
  if (subtotal === null) {
    for (const line of lines) {
      if (!/Итого\s*:/.test(line)) continue;            // именно «Итого:»
      if (/с\s*НДС/i.test(line)) continue;             // не «Итого с НДС:»
      const nums = extractNumbers(line);
      if (nums.length > 0) {
        subtotal = nums[nums.length - 1];
        break;
      }
    }
  }

  // --- НДС ---
  // «Без налога (НДС): -» — признак счёта без НДС (только как сигнатура итоговой строки,
  // не просто слово «без налога» в шапке/колонке УПД).
  const withoutVat = lines.some((l) => /без\s*налог[а-я]*\s*\(?\s*НДС/i.test(l));
  let vatAmount: number | null = withoutVat ? 0 : null;
  let vatPercent: number | null = withoutVat ? 0 : null;

  if (!withoutVat) {
    // «Сумма НДС …%: …» / «НДС: …» — последнее число строки (но не «Итого с НДС»).
    for (const line of lines) {
      if (!/НДС/i.test(line)) continue;
      if (/с\s*НДС|Итого\s+с/i.test(line)) continue;
      const nums = extractNumbers(line);
      if (nums.length > 0) {
        vatAmount = nums[nums.length - 1];
        const pct = line.match(/(\d{1,2})\s*%/);
        if (pct) vatPercent = Number(pct[1]);
        break;
      }
    }
    // НДС как разница (УПД/счёт-фактура без отдельной строки НДС).
    if (vatAmount === null && subtotal !== null) {
      vatAmount = Math.round((totalWithVat - subtotal) * 100) / 100;
    }
    if (vatPercent === null && subtotal && subtotal > 0 && vatAmount !== null) {
      vatPercent = Math.round((vatAmount / subtotal) * 100);
    }
  }

  return {
    subtotal,
    vatPercent,
    vatAmount,
    totalWithVat,
    unit: detectUnit(text),
    quantity: null,
    pricePerUnit: null,
    issue: null
  };
}
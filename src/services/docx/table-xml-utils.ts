/**
 * Общие низкоуровневые утилиты для работы с таблицами внутри word/document.xml
 * (используются DocxBillsTableService, BillsLedgerVectorService и BillsPeriodReportService).
 */

export const RU_MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

export function formatMonthLabel(date: Date): string {
  const month = RU_MONTHS[date.getMonth()];
  return `${month} ${date.getFullYear()}`;
}

/** Разбирает подпись месяца вида "Май 2026" в { year, month(0-based) }. Возвращает null, если не удалось распознать. */
export function parseMonthLabel(label: string): { year: number; month: number } | null {
  const match = /([А-Яа-яё]+)\s+(\d{4})/.exec(label.trim());
  if (!match) return null;
  const monthIndex = RU_MONTHS.findIndex((m) => m.toLowerCase() === match[1].toLowerCase());
  if (monthIndex === -1) return null;
  return { year: Number(match[2]), month: monthIndex };
}

export function formatAmount(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

export function parseAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Находит XML последней таблицы (<w:tbl>) в теле документа. */
export function extractLastTable(documentXml: string): { table: string; start: number; end: number } {
  const tableRegex = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;

  while ((match = tableRegex.exec(documentXml)) !== null) {
    last = match;
  }

  if (!last) {
    throw new Error('В документе не найдено ни одной таблицы.');
  }

  return { table: last[0], start: last.index, end: last.index + last[0].length };
}

export function extractRows(tableXml: string): string[] {
  const rowRegex = /<w:tr[ >][\s\S]*?<\/w:tr>/g;
  const rows: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(tableXml)) !== null) {
    rows.push(match[0]);
  }

  return rows;
}

export function extractCells(rowXml: string): string[] {
  const cellRegex = /<w:tc>[\s\S]*?<\/w:tc>/g;
  const cells: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = cellRegex.exec(rowXml)) !== null) {
    cells.push(match[0]);
  }

  return cells;
}

export function extractCellTexts(cellXml: string): string[] {
  const textRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  const texts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = textRegex.exec(cellXml)) !== null) {
    if (match[1]) texts.push(match[1]);
  }
  return texts;
}

/**
 * Заменяет последнее числовое значение <w:t> в ячейке на новую сумму.
 * Если числового значения нет — заменяет последний непустой текстовый узел.
 */
export function replaceAmountInCell(cellXml: string, newValue: string): string {
  const textRegex = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;
  let match: RegExpExecArray | null;
  let lastNumericMatch: RegExpExecArray | null = null;
  let lastAnyMatch: RegExpExecArray | null = null;

  while ((match = textRegex.exec(cellXml)) !== null) {
    const text = match[2].trim();
    if (text) {
      lastAnyMatch = match;
      if (/^[\d\s.,]+$/.test(text)) {
        lastNumericMatch = match;
      }
    }
  }

  const target = lastNumericMatch || lastAnyMatch;
  if (!target) {
    return cellXml;
  }

  const contentStart = target.index + target[1].length;
  const contentEnd = contentStart + target[2].length;
  return cellXml.slice(0, contentStart) + escapeXml(newValue) + cellXml.slice(contentEnd);
}

/**
 * Заменяет текст месяца в первом параграфе ячейки, сохраняя остальные
 * параграфы ячейки (например, строку "ставка НДС 22%") без изменений.
 */
export function replaceMonthInCell(cellXml: string, newMonthLabel: string): string {
  const paragraphMatch = /<w:p>[\s\S]*?<\/w:p>/.exec(cellXml);
  if (!paragraphMatch) {
    return cellXml;
  }

  const paragraphXml = paragraphMatch[0];
  const pPrMatch = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraphXml);
  const pPr = pPrMatch ? pPrMatch[0] : '';
  const newParagraph = `<w:p>${pPr}<w:r><w:rPr/><w:t>${escapeXml(newMonthLabel)}</w:t></w:r></w:p>`;

  return cellXml.slice(0, paragraphMatch.index) + newParagraph + cellXml.slice(paragraphMatch.index + paragraphXml.length);
}

export function rowOpeningTag(rowXml: string): string {
  const trOpenMatch = /^<w:tr[^>]*>/.exec(rowXml);
  return trOpenMatch ? trOpenMatch[0] : '<w:tr>';
}

/** Находит все параграфы (<w:p>) в произвольном фрагменте XML (документ, ячейка и т.п.). */
export function extractParagraphs(xml: string): string[] {
  const paraRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  const paragraphs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = paraRegex.exec(xml)) !== null) {
    paragraphs.push(match[0]);
  }
  return paragraphs;
}

/** Возвращает rPr первого текстового run внутри параграфа (не путать с rPr самого pPr). */
function firstRunRPr(paragraphXml: string): string {
  const withoutPPr = paragraphXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');
  const match = /<w:r(?:\s[^>]*)?>\s*(<w:rPr\/>|<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(withoutPPr);
  return match ? match[1] : '<w:rPr/>';
}

/**
 * Заменяет содержимое параграфа на один run с новым текстом, сохраняя w:pPr
 * и форматирование (rPr) первого run параграфа (например, жирный шрифт).
 */
export function replaceParagraphText(paragraphXml: string, newText: string): string {
  const pPrMatch = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraphXml);
  const pPr = pPrMatch ? pPrMatch[0] : '';
  const rPr = firstRunRPr(paragraphXml);
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r></w:p>`;
}

/** Заменяет текст первого параграфа ячейки на newText, сохраняя форматирование. */
export function setCellText(cellXml: string, newText: string): string {
  const paragraphMatch = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/.exec(cellXml);
  if (!paragraphMatch) {
    return cellXml;
  }
  const newParagraph = replaceParagraphText(paragraphMatch[0], newText);
  return (
    cellXml.slice(0, paragraphMatch.index) +
    newParagraph +
    cellXml.slice(paragraphMatch.index + paragraphMatch[0].length)
  );
}

/**
 * В параграфе, содержащем run(ы) с текстом label, оставляет всё до и включая
 * run с label, а после него добавляет один новый run со значением newValue
 * (сохраняя rPr следующего за label run, если он есть — обычно это "обычный" стиль значения).
 */
export function replaceParagraphValueAfterLabel(paragraphXml: string, label: string, newValue: string): string {
  const runRegex = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  const runs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = runRegex.exec(paragraphXml)) !== null) {
    runs.push(match[0]);
  }

  let labelIdx = -1;
  for (let i = 0; i < runs.length; i++) {
    if (runs[i].includes(label)) {
      labelIdx = i;
      break;
    }
  }
  if (labelIdx === -1) {
    return paragraphXml;
  }

  const afterLabelRun = runs[labelIdx + 1];
  const rPrMatch = afterLabelRun ? /<w:rPr\/>|<w:rPr>[\s\S]*?<\/w:rPr>/.exec(afterLabelRun) : null;
  const rPr = rPrMatch ? rPrMatch[0] : '<w:rPr/>';

  const pPrMatch = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraphXml);
  const pPr = pPrMatch ? pPrMatch[0] : '';

  const keptRuns = runs.slice(0, labelIdx + 1).join('');
  const newRun = `<w:r>${rPr}<w:t xml:space="preserve"> ${escapeXml(newValue)}</w:t></w:r>`;

  return `<w:p>${pPr}${keptRuns}${newRun}</w:p>`;
}

/**
 * Находит в documentXml первый параграф, чей текст удовлетворяет predicate,
 * заменяет его через transform(paragraphXml) и возвращает обновлённый documentXml.
 * Бросает исключение, если подходящий параграф не найден.
 */
export function replaceFirstMatchingParagraph(
  documentXml: string,
  predicate: (paragraphText: string) => boolean,
  transform: (paragraphXml: string) => string
): string {
  const paraRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = paraRegex.exec(documentXml)) !== null) {
    const text = extractCellTexts(match[0]).join('');
    if (predicate(text)) {
      const newParagraph = transform(match[0]);
      return documentXml.slice(0, match.index) + newParagraph + documentXml.slice(match.index + match[0].length);
    }
  }
  throw new Error('Параграф, удовлетворяющий условию, не найден.');
}

/** Форматирует число в строку с запятой как десятичным разделителем (русский формат). */
export function formatNumberRu(value: number): string {
  return String(value).replace('.', ',');
}

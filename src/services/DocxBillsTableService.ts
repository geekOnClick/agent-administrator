import fs from 'fs';
import JSZip from 'jszip';
import { BillCategory } from '../llm/prompts/profiles.js';

const RU_MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

/**
 * Порядок столбцов (после столбца с месяцем) в таблице учёта коммунальных
 * платежей файла "Администрирование_2_0.docx":
 * месяц | теплоэнергия | электроэнергия | содержание помещения | водоканал | вывоз мусора
 */
const COLUMN_CATEGORY_ORDER: BillCategory[] = ['heat', 'electricity', 'maintenance', 'water', 'garbage'];

export interface DocxTableAppendResult {
  monthLabel: string;
  docPath: string;
  amounts: Record<BillCategory, number | null>;
}

/**
 * Сервис для дозаполнения (продолжения) таблицы учёта коммунальных платежей
 * в .docx-файле новой строкой по шаблону последней существующей строки.
 */
export class DocxBillsTableService {
  private formatAmount(value: number): string {
    return value.toFixed(2).replace('.', ',');
  }

  private formatMonthLabel(date: Date): string {
    const month = RU_MONTHS[date.getMonth()];
    return `${month} ${date.getFullYear()}`;
  }

  private escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Находит XML последней таблицы (<w:tbl>) в теле документа.
   */
  private extractLastTable(documentXml: string): { table: string; start: number; end: number } {
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

  private extractRows(tableXml: string): string[] {
    const rowRegex = /<w:tr[ >][\s\S]*?<\/w:tr>/g;
    const rows: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = rowRegex.exec(tableXml)) !== null) {
      rows.push(match[0]);
    }

    return rows;
  }

  private extractCells(rowXml: string): string[] {
    const cellRegex = /<w:tc>[\s\S]*?<\/w:tc>/g;
    const cells: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = cellRegex.exec(rowXml)) !== null) {
      cells.push(match[0]);
    }

    return cells;
  }

  /**
   * Заменяет последнее числовое значение <w:t> в ячейке на новую сумму.
   * Если числового значения нет — заменяет последний непустой текстовый узел.
   */
  private replaceAmountInCell(cellXml: string, newValue: string): string {
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
    return cellXml.slice(0, contentStart) + this.escapeXml(newValue) + cellXml.slice(contentEnd);
  }

  /**
   * Заменяет текст месяца в первом параграфе ячейки, сохраняя остальные
   * параграфы ячейки (например, строку "ставка НДС 22%") без изменений.
   */
  private replaceMonthInCell(cellXml: string, newMonthLabel: string): string {
    const paragraphMatch = /<w:p>[\s\S]*?<\/w:p>/.exec(cellXml);
    if (!paragraphMatch) {
      return cellXml;
    }

    const paragraphXml = paragraphMatch[0];
    const pPrMatch = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraphXml);
    const pPr = pPrMatch ? pPrMatch[0] : '';
    const newParagraph = `<w:p>${pPr}<w:r><w:rPr/><w:t>${this.escapeXml(newMonthLabel)}</w:t></w:r></w:p>`;

    return cellXml.slice(0, paragraphMatch.index) + newParagraph + cellXml.slice(paragraphMatch.index + paragraphXml.length);
  }

  /**
   * Добавляет новую строку в конец таблицы учёта коммунальных платежей,
   * используя последнюю существующую строку как шаблон стилей/границ.
   * Столбцы сопоставляются по фиксированному порядку категорий:
   * месяц | теплоэнергия | электроэнергия | содержание помещения | водоканал | вывоз мусора.
   */
  async appendMonthlyRow(
    docPath: string,
    amountsByCategory: Partial<Record<BillCategory, number>>,
    monthDate: Date = new Date()
  ): Promise<DocxTableAppendResult> {
    if (!fs.existsSync(docPath)) {
      throw new Error(`Файл таблицы учёта не найден: ${docPath}`);
    }

    const buffer = fs.readFileSync(docPath);
    const zip = await JSZip.loadAsync(buffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      throw new Error('В .docx-файле не найден word/document.xml — файл повреждён или не является .docx.');
    }

    const documentXml = await documentXmlFile.async('string');
    const { table, start, end } = this.extractLastTable(documentXml);
    const rows = this.extractRows(table);
    if (rows.length === 0) {
      throw new Error('В последней таблице документа не найдено строк-образцов.');
    }

    const templateRow = rows[rows.length - 1];
    const cells = this.extractCells(templateRow);
    if (cells.length < COLUMN_CATEGORY_ORDER.length + 1) {
      throw new Error(
        `Неожиданная структура таблицы: ожидалось не менее ${COLUMN_CATEGORY_ORDER.length + 1} столбцов, найдено ${cells.length}.`
      );
    }

    const monthLabel = this.formatMonthLabel(monthDate);
    const newCells: string[] = [this.replaceMonthInCell(cells[0], monthLabel)];

    const resultAmounts: Record<BillCategory, number | null> = {
      heat: null,
      electricity: null,
      maintenance: null,
      water: null,
      garbage: null
    };

    for (let i = 0; i < COLUMN_CATEGORY_ORDER.length; i++) {
      const category = COLUMN_CATEGORY_ORDER[i];
      const cellXml = cells[i + 1];
      const amount = amountsByCategory[category];
      if (typeof amount === 'number') {
        resultAmounts[category] = amount;
        newCells.push(this.replaceAmountInCell(cellXml, this.formatAmount(amount)));
      } else {
        newCells.push(cellXml);
      }
    }

    // Дополнительные столбцы сверх известных категорий (если есть) переносим как есть.
    for (let i = COLUMN_CATEGORY_ORDER.length + 1; i < cells.length; i++) {
      newCells.push(cells[i]);
    }

    const trOpenMatch = /^<w:tr[^>]*>/.exec(templateRow);
    const trOpen = trOpenMatch ? trOpenMatch[0] : '<w:tr>';
    const newRow = `${trOpen}${newCells.join('')}</w:tr>`;

    const templateRowIndexInTable = table.lastIndexOf(templateRow);
    const insertPos = templateRowIndexInTable + templateRow.length;
    const updatedTable = table.slice(0, insertPos) + newRow + table.slice(insertPos);

    const updatedDocumentXml = documentXml.slice(0, start) + updatedTable + documentXml.slice(end);

    zip.file('word/document.xml', updatedDocumentXml);
    const outBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(docPath, outBuffer);

    return { monthLabel, docPath, amounts: resultAmounts };
  }
}

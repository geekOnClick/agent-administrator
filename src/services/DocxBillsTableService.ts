import fs from 'fs';
import JSZip from 'jszip';
import { BillCategory } from '../llm/prompts/profiles.js';
import {
  formatAmount,
  formatMonthLabel,
  extractLastTable,
  extractRows,
  extractCells,
  replaceAmountInCell,
  replaceMonthInCell,
  rowOpeningTag
} from './docx/table-xml-utils.js';

/**
 * Порядок столбцов (после столбца с месяцем) в таблице учёта коммунальных
 * платежей файла "Администрирование_2_0.docx":
 * месяц | теплоэнергия | электроэнергия | содержание помещения | водоканал | вывоз мусора
 */
export const COLUMN_CATEGORY_ORDER: BillCategory[] = ['heat', 'electricity', 'maintenance', 'water', 'garbage'];

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
    const { table, start, end } = extractLastTable(documentXml);
    const rows = extractRows(table);
    if (rows.length === 0) {
      throw new Error('В последней таблице документа не найдено строк-образцов.');
    }

    const templateRow = rows[rows.length - 1];
    const cells = extractCells(templateRow);
    if (cells.length < COLUMN_CATEGORY_ORDER.length + 1) {
      throw new Error(
        `Неожиданная структура таблицы: ожидалось не менее ${COLUMN_CATEGORY_ORDER.length + 1} столбцов, найдено ${cells.length}.`
      );
    }

    const monthLabel = formatMonthLabel(monthDate);
    const newCells: string[] = [replaceMonthInCell(cells[0], monthLabel)];

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
        newCells.push(replaceAmountInCell(cellXml, formatAmount(amount)));
      } else {
        newCells.push(cellXml);
      }
    }

    // Дополнительные столбцы сверх известных категорий (если есть) переносим как есть.
    for (let i = COLUMN_CATEGORY_ORDER.length + 1; i < cells.length; i++) {
      newCells.push(cells[i]);
    }

    const trOpen = rowOpeningTag(templateRow);
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

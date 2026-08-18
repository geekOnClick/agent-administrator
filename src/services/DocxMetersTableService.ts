import fs from 'fs';
import JSZip from 'jszip';
import {
  formatShortDate,
  extractLastTable,
  extractRows,
  extractCells,
  setCellText,
  rowOpeningTag
} from './docx/table-xml-utils.js';

export interface DocxMeterAppendResult {
  docPath: string;
  dateLabel: string;
  value: string;
}

/**
 * Сервис для дозаполнения (продолжения) таблицы показаний счётчика
 * ("электроэнергия.docx" / "водоканал.docx", 2 столбца: дата | показания)
 * новой строкой по шаблону последней существующей строки — по аналогии
 * с DocxBillsTableService для "Администрирование_2_0.docx".
 */
export class DocxMetersTableService {
  /**
   * Добавляет новую строку в конец таблицы показаний счётчика: текущая дата
   * (формат ДД.ММ.ГГ) и переданное показание (строка цифр, как ввёл пользователь).
   */
  async appendMeterRow(
    docPath: string,
    value: string,
    date: Date = new Date()
  ): Promise<DocxMeterAppendResult> {
    if (!fs.existsSync(docPath)) {
      throw new Error(`Файл таблицы показаний счётчика не найден: ${docPath}`);
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
      throw new Error('В таблице показаний счётчика не найдено строк-образцов.');
    }

    const templateRow = rows[rows.length - 1];
    const cells = extractCells(templateRow);
    if (cells.length < 2) {
      throw new Error(`Неожиданная структура таблицы показаний счётчика: ожидалось 2 столбца, найдено ${cells.length}.`);
    }

    const dateLabel = formatShortDate(date);
    const newCells = [setCellText(cells[0], dateLabel), setCellText(cells[1], value)];

    const trOpen = rowOpeningTag(templateRow);
    const newRow = `${trOpen}${newCells.join('')}</w:tr>`;

    const templateRowIndexInTable = table.lastIndexOf(templateRow);
    const insertPos = templateRowIndexInTable + templateRow.length;
    const updatedTable = table.slice(0, insertPos) + newRow + table.slice(insertPos);

    const updatedDocumentXml = documentXml.slice(0, start) + updatedTable + documentXml.slice(end);

    zip.file('word/document.xml', updatedDocumentXml);
    const outBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(docPath, outBuffer);

    return { docPath, dateLabel, value };
  }
}

export const docxMetersTableService = new DocxMetersTableService();

import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { COLUMN_CATEGORY_ORDER } from './DocxBillsTableService.js';
import {
  formatAmount,
  parseMonthLabel,
  extractLastTable,
  extractRows,
  extractCells,
  replaceAmountInCell,
  replaceMonthInCell,
  rowOpeningTag
} from './docx/table-xml-utils.js';
import { BillsLedgerRow } from './vector/BillsLedgerVectorService.js';

export interface PeriodReportPeriod {
  fromYear: number;
  fromMonth: number; // 0-based
  toYear: number;
  toMonth: number; // 0-based
}

export interface PeriodReportResult {
  reportPath: string;
  rowsIncluded: number;
  period: PeriodReportPeriod;
}

const PERIOD_REGEX = /^(\d{1,2})\/(\d{2})-(\d{1,2})\/(\d{2})$/;

/**
 * Парсит строку вида "05/26-08/26" (MM/YY-MM/YY) в диапазон месяцев.
 * Год трактуется как 20YY.
 */
export function parsePeriodArg(raw: string): PeriodReportPeriod {
  const match = PERIOD_REGEX.exec(raw.trim());
  if (!match) {
    throw new Error(
      `Неверный формат периода: "${raw}". Ожидается формат вида "05/26-08/26" (ММ/ГГ-ММ/ГГ).`
    );
  }

  const [, fromM, fromY, toM, toY] = match;
  const fromMonth = Number(fromM) - 1;
  const toMonth = Number(toM) - 1;
  const fromYear = 2000 + Number(fromY);
  const toYear = 2000 + Number(toY);

  if (fromMonth < 0 || fromMonth > 11 || toMonth < 0 || toMonth > 11) {
    throw new Error(`Неверный номер месяца в периоде: "${raw}".`);
  }

  return { fromYear, fromMonth, toYear, toMonth };
}

function monthKey(year: number, month: number): number {
  return year * 12 + month;
}

function isWithinPeriod(row: BillsLedgerRow, period: PeriodReportPeriod): boolean {
  const parsed = parseMonthLabel(row.month);
  if (!parsed) return false;
  const key = monthKey(parsed.year, parsed.month);
  return key >= monthKey(period.fromYear, period.fromMonth) && key <= monthKey(period.toYear, period.toMonth);
}

/**
 * Сервис формирования отдельного .docx-отчёта (режим "report"): строит таблицу того же
 * вида, что и в "Администрирование_2_0.docx", но только со строками за указанный период,
 * исходя из исходного файла-шаблона как источник стилей/структуры.
 */
export class BillsPeriodReportService {
  /**
   * Строит отдельный .docx-файл отчёта с таблицей, содержащей только строки
   * из указанного диапазона месяцев (включительно), на основе исходной таблицы учёта.
   */
  async generateReport(
    sourceLedgerPath: string,
    ledgerRows: BillsLedgerRow[],
    period: PeriodReportPeriod,
    outputDir: string
  ): Promise<PeriodReportResult> {
    if (!fs.existsSync(sourceLedgerPath)) {
      throw new Error(`Исходный файл таблицы учёта не найден: ${sourceLedgerPath}`);
    }

    const rowsInPeriod = ledgerRows
      .filter((r) => isWithinPeriod(r, period))
      .sort((a, b) => {
        const pa = parseMonthLabel(a.month);
        const pb = parseMonthLabel(b.month);
        if (!pa || !pb) return 0;
        return monthKey(pa.year, pa.month) - monthKey(pb.year, pb.month);
      });

    const buffer = fs.readFileSync(sourceLedgerPath);
    const zip = await JSZip.loadAsync(buffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      throw new Error('В .docx-файле не найден word/document.xml.');
    }

    const documentXml = await documentXmlFile.async('string');
    const { table, start, end } = extractLastTable(documentXml);
    const rows = extractRows(table);
    if (rows.length === 0) {
      throw new Error('В исходной таблице не найдено строк-образцов.');
    }

    const headerRow = rows[0];
    const templateRow = rows[rows.length - 1];
    const templateCells = extractCells(templateRow);
    if (templateCells.length < COLUMN_CATEGORY_ORDER.length + 1) {
      throw new Error(
        `Неожиданная структура таблицы: ожидалось не менее ${COLUMN_CATEGORY_ORDER.length + 1} столбцов, найдено ${templateCells.length}.`
      );
    }

    const trOpen = rowOpeningTag(templateRow);
    const newRows: string[] = [headerRow];

    for (const row of rowsInPeriod) {
      const newCells: string[] = [replaceMonthInCell(templateCells[0], row.month)];
      for (let i = 0; i < COLUMN_CATEGORY_ORDER.length; i++) {
        const category = COLUMN_CATEGORY_ORDER[i];
        const cellXml = templateCells[i + 1];
        const amount = row.amounts[category];
        newCells.push(
          typeof amount === 'number' ? replaceAmountInCell(cellXml, formatAmount(amount)) : cellXml
        );
      }
      for (let i = COLUMN_CATEGORY_ORDER.length + 1; i < templateCells.length; i++) {
        newCells.push(templateCells[i]);
      }
      newRows.push(`${trOpen}${newCells.join('')}</w:tr>`);
    }

    const tblPrEnd = table.indexOf('</w:tblGrid>');
    const preamble = tblPrEnd !== -1 ? table.slice(0, tblPrEnd + '</w:tblGrid>'.length) : '<w:tbl>';
    const newTable = `${preamble}${newRows.join('')}</w:tbl>`;

    const newDocumentXml = documentXml.slice(0, start) + newTable + documentXml.slice(end);

    zip.file('word/document.xml', newDocumentXml);
    const outBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const fileName = `Отчёт_${String(period.fromMonth + 1).padStart(2, '0')}.${period.fromYear}-${String(
      period.toMonth + 1
    ).padStart(2, '0')}.${period.toYear}.docx`;
    const reportPath = path.join(outputDir, fileName);
    fs.writeFileSync(reportPath, outBuffer);

    return { reportPath, rowsIncluded: rowsInPeriod.length, period };
  }
}

export const billsPeriodReportService = new BillsPeriodReportService();


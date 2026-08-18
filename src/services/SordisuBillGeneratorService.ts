import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import JSZip from 'jszip';
import { routerAIService, BillColumnsExtractResult } from './RouterAIService.js';
import { amountToWordsRu } from './docx/number-to-words-ru.js';
import {
  extractLastTable,
  extractRows,
  extractCells,
  extractCellTexts,
  setCellText,
  replaceParagraphText,
  replaceParagraphValueAfterLabel,
  replaceFirstMatchingParagraph,
  formatAmount,
  formatNumberRu,
  rowOpeningTag
} from './docx/table-xml-utils.js';
import {
  getCurrentMonthDir as getCurrentOrganizeBillsMonthDir,
  getCategoryDir,
  EXPECTED_AMOUNT_MANIFEST_FILE,
  ExpectedAmountManifest,
  CATEGORY_DIR_NAMES
} from '../mcp/tools/organize-bills.tool.js';

// Папка категории "содержание помещения", которую не нужно копировать в счета "Сордису".
const EXCLUDED_ORGANIZED_DIR_NAME = CATEGORY_DIR_NAMES.maintenance;

// Базовая директория с папками по месяцам для документов "Сордису".
export const SORDISU_BASE_DIR =
  '/home/geekonclick/Рабочий стол/Администрирование2026/Сордису по месяцам';

// Папка-шаблон, из которой копируются файлы в новую папку месяца.
export const SORDISU_TEMPLATE_DIR = path.join(SORDISU_BASE_DIR, 'шаблон_для_агента');

// Названия месяцев в именительном падеже, с маленькой буквы
// (используются как имя папки месяца и как значение "следующего месяца" в счёте).
const MONTH_NAMES_LOWER = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'
];

// Названия месяцев в родительном падеже, с маленькой буквы
// (используются в дате счёта: "«18» августа 2026 г.").
const MONTH_NAMES_GENITIVE_LOWER = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];

// Плейсхолдеры в шаблоне "счет.doc", подлежащие замене.
const DATE_PLACEHOLDER = '«текущее число» «текущий месяц» «текущий год»';
const NEXT_MONTH_PLACEHOLDER = '«следующий месяц после текущего»';

// Категории коммунальных услуг, представленные в таблице "свравка-расчет.docx" (без "содержания помещения").
type SpravkaCategory = 'electricity' | 'heat' | 'water' | 'garbage';

// Ключевые слова для определения, к какой категории относится строка таблицы по содержимому ячейки "Наименование".
const SPRAVKA_ROW_CATEGORY_KEYWORDS: Array<{ category: SpravkaCategory; keyword: string }> = [
  { category: 'electricity', keyword: 'Электроэнергия' },
  { category: 'heat', keyword: 'Теплоэнергия' },
  { category: 'garbage', keyword: 'коммунальными отходами' },
  { category: 'water', keyword: 'Водоснабжение' }
];

/** Возвращает путь к папке текущего месяца (с маленькой буквы) внутри baseDir. */
export function getCurrentSordisuMonthDir(
  baseDir: string = SORDISU_BASE_DIR,
  date: Date = new Date()
): string {
  return path.join(baseDir, MONTH_NAMES_LOWER[date.getMonth()]);
}

export interface CreateMonthFolderResult {
  monthDir: string;
  copiedFiles: string[];
}

export interface FillBillDocResult {
  pdfPath: string;
}

export interface FillSpravkaDocResult {
  pdfPath: string;
  totalWithVat: number;
  categoriesFilled: SpravkaCategory[];
  warnings: string[];
}

export interface FillKommunalkaDocResult {
  pdfPath: string;
}

export interface CopyOrganizedDocsResult {
  copiedFiles: string[];
}

// Столбцы таблицы справки-расчёта (после № и Наименования):
// Ед.изм | Кол-во | Цена/ед. | Сумма | НДС% | Сумма НДС | Всего с НДС
const SPRAVKA_COLUMN_UNIT_INDEX = 2;
const SPRAVKA_COLUMN_QUANTITY_INDEX = 3;
const SPRAVKA_COLUMN_PRICE_INDEX = 4;
const SPRAVKA_COLUMN_AMOUNT_INDEX = 5;
const SPRAVKA_COLUMN_VAT_PERCENT_INDEX = 6;
const SPRAVKA_COLUMN_VAT_AMOUNT_INDEX = 7;
const SPRAVKA_COLUMN_TOTAL_INDEX = 8;

interface AggregatedBillColumns {
  unit: string | null;
  quantity: number | null;
  pricePerUnit: number | null;
  amount: number | null;
  vatPercent: number | null;
  vatAmount: number | null;
  totalWithVat: number | null;
}

/**
 * Сервис подготовки ежемесячного счёта "Сордису": создаёт папку текущего месяца,
 * копирует туда файлы шаблона, заполняет актуальные даты в "счет.doc",
 * сохраняет результат в pdf и удаляет исходный .doc.
 */
export class SordisuBillGeneratorService {
   /**
    * Рекурсивно обходит папку месяца "Документы по месяцам/<месяц>" (включая все подпапки категорий)
    * (созданную ранее в цикле скачивания/проверки квитанций) и копирует все найденные файлы счетов
    * и квитанций плоско, без подпапок, прямо в папку месяца "Сордису по месяцам". Документы из папки
    * "Наш дом" (содержание помещения) не копируются. При совпадении имён файлов из разных категорий
    * добавляется суффикс " (1)", " (2)" и т.д. Служебные манифесты и lock-файлы не копируются.
    */
  copyOrganizedDocsToMonthFolder(
    sordisuMonthDir: string,
    orgMonthDir: string,
    excludeCategories: string[] = []
  ): CopyOrganizedDocsResult {
    const copiedFiles: string[] = [];
    if (!fs.existsSync(orgMonthDir)) {
      return { copiedFiles };
    }

    fs.mkdirSync(sordisuMonthDir, { recursive: true });

    // Помимо папки "Наш дом" (содержание помещения), не копируются папки категорий,
    // по которым не была найдена квитанция об оплате (переданы через excludeCategories) —
    // такие ресурсы не должны попадать в итоговый счёт "Сордису".
    const excludedDirNames = new Set<string>([EXCLUDED_ORGANIZED_DIR_NAME]);
    for (const category of excludeCategories) {
      const dirName = CATEGORY_DIR_NAMES[category];
      if (dirName) {
        excludedDirNames.add(dirName);
      }
    }

    const resolveDestPath = (fileName: string): string => {
      const ext = path.extname(fileName);
      const base = path.basename(fileName, ext);
      let candidate = path.join(sordisuMonthDir, fileName);
      let counter = 1;
      while (fs.existsSync(candidate)) {
        candidate = path.join(sordisuMonthDir, `${base} (${counter})${ext}`);
        counter += 1;
      }
      return candidate;
    };

    const copyDirRecursive = (srcDir: string): void => {
      const entries = fs.readdirSync(srcDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.~lock.')) continue;
        if (entry.name === EXPECTED_AMOUNT_MANIFEST_FILE) continue;
        if (entry.isDirectory() && excludedDirNames.has(entry.name)) continue;

        const srcPath = path.join(srcDir, entry.name);

        if (entry.isDirectory()) {
          copyDirRecursive(srcPath);
        } else if (entry.isFile()) {
          const destPath = resolveDestPath(entry.name);
          fs.copyFileSync(srcPath, destPath);
          copiedFiles.push(destPath);
        }
      }
    };

    copyDirRecursive(orgMonthDir);
    return { copiedFiles };
  }

  /**
   * Создаёт папку текущего месяца (с маленькой буквы) в SORDISU_BASE_DIR
   * и копирует в неё все файлы из папки-шаблона (кроме служебных lock-файлов LibreOffice).
   */
  createMonthFolderFromTemplate(date: Date = new Date()): CreateMonthFolderResult {
    const monthDir = getCurrentSordisuMonthDir(SORDISU_BASE_DIR, date);
    fs.mkdirSync(monthDir, { recursive: true });

    const entries = fs.readdirSync(SORDISU_TEMPLATE_DIR, { withFileTypes: true });
    const copiedFiles: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.~lock.')) continue; // служебный файл блокировки LibreOffice

      const src = path.join(SORDISU_TEMPLATE_DIR, entry.name);
      const dest = path.join(monthDir, entry.name);
      fs.copyFileSync(src, dest);
      copiedFiles.push(dest);
    }

    return { monthDir, copiedFiles };
  }

  /**
   * Запускает headless-конвертацию LibreOffice в изолированном профиле пользователя,
   * чтобы вызов не зависел от других (в т.ч. открытых в GUI) процессов soffice
   * и не завершался с ошибкой из-за занятого профиля.
   */
  private runHeadlessConvert(format: 'docx' | 'pdf', dir: string, srcPath: string): void {
    const userInstallDir = path.join(
      os.tmpdir(),
      `loconv-${format}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const userInstallUrl = pathToFileURL(userInstallDir).toString();
    try {
      execSync(
        `libreoffice --headless --norestore "-env:UserInstallation=${userInstallUrl}" --convert-to ${format} --outdir "${dir}" "${srcPath}"`,
        { stdio: 'pipe', timeout: 60000 }
      );
    } finally {
      fs.rmSync(userInstallDir, { recursive: true, force: true });
    }
  }

  private convertDocToDocx(docPath: string): string {
    const dir = path.dirname(docPath);
    const base = path.basename(docPath, path.extname(docPath));
    const outPath = path.join(dir, `${base}.docx`);
    if (fs.existsSync(outPath)) {
      fs.unlinkSync(outPath);
    }
    this.runHeadlessConvert('docx', dir, docPath);
    if (!fs.existsSync(outPath)) {
      throw new Error(`Конвертация в docx не создала файл: ${outPath}`);
    }
    return outPath;
  }

  private convertDocxToPdf(docxPath: string): string {
    const dir = path.dirname(docxPath);
    const base = path.basename(docxPath, path.extname(docxPath));
    const outPath = path.join(dir, `${base}.pdf`);
    if (fs.existsSync(outPath)) {
      fs.unlinkSync(outPath);
    }
    this.runHeadlessConvert('pdf', dir, docxPath);
    if (!fs.existsSync(outPath)) {
      throw new Error(`Конвертация в pdf не создала файл: ${outPath}`);
    }
    return outPath;
  }

  /** Строка даты счёта, например «18» августа 2026 г. — по образцу прошлых счетов. */
  private buildBillDateReplacement(date: Date): string {
    const day = date.getDate();
    const monthGenitive = MONTH_NAMES_GENITIVE_LOWER[date.getMonth()];
    const year = date.getFullYear();
    return `«${day}» ${monthGenitive} ${year} г.`;
  }

  /** Название месяца, следующего за текущим (именительный падеж, с маленькой буквы). */
  private buildNextMonthReplacement(date: Date): string {
    const nextMonthIndex = (date.getMonth() + 1) % 12;
    return MONTH_NAMES_LOWER[nextMonthIndex];
  }

  /**
   * Заполняет плейсхолдеры дат в "счет.doc" (в строке "СЧЕТ № 1 от ..." и в ячейке таблицы
   * с арендной платой), сохраняет результат как pdf в той же папке и удаляет исходный .doc.
   * Больше никакие данные в документе не меняются.
   */
  async fillAndConvertBillDoc(monthDir: string, date: Date = new Date()): Promise<FillBillDocResult> {
    const docPath = path.join(monthDir, 'счет.doc');
    if (!fs.existsSync(docPath)) {
      throw new Error(`Файл счёта не найден: ${docPath}`);
    }

    const docxPath = this.convertDocToDocx(docPath);

    try {
      const buffer = fs.readFileSync(docxPath);
      const zip = await JSZip.loadAsync(buffer);
      const documentXmlFile = zip.file('word/document.xml');
      if (!documentXmlFile) {
        throw new Error('В .docx-файле не найден word/document.xml — файл повреждён или не является .docx.');
      }

      let documentXml = await documentXmlFile.async('string');

      if (!documentXml.includes(DATE_PLACEHOLDER)) {
        throw new Error(`В документе не найден плейсхолдер даты счёта: ${DATE_PLACEHOLDER}`);
      }
      if (!documentXml.includes(NEXT_MONTH_PLACEHOLDER)) {
        throw new Error(`В документе не найден плейсхолдер месяца аренды: ${NEXT_MONTH_PLACEHOLDER}`);
      }

      const dateReplacement = this.buildBillDateReplacement(date);
      const nextMonthReplacement = this.buildNextMonthReplacement(date);

      documentXml = documentXml.split(DATE_PLACEHOLDER).join(dateReplacement);
      documentXml = documentXml.split(NEXT_MONTH_PLACEHOLDER).join(nextMonthReplacement);

      zip.file('word/document.xml', documentXml);
      const outBuffer = await zip.generateAsync({ type: 'nodebuffer' });
      fs.writeFileSync(docxPath, outBuffer);

      const pdfPath = this.convertDocxToPdf(docxPath);
      return { pdfPath };
    } finally {
      if (fs.existsSync(docxPath)) {
        fs.unlinkSync(docxPath);
      }
      if (fs.existsSync(docPath)) {
        fs.unlinkSync(docPath);
      }
    }
  }

  /** Читает список файлов исходного счёта категории из манифеста organize_bills. */
  private getBillFilesForCategory(orgMonthDir: string, category: SpravkaCategory): string[] {
    const catDir = getCategoryDir(orgMonthDir, category);
    if (!catDir) return [];

    const manifestPath = path.join(catDir, EXPECTED_AMOUNT_MANIFEST_FILE);
    if (!fs.existsSync(manifestPath)) return [];

    let manifest: ExpectedAmountManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return [];
    }

    return manifest.billFiles
      .map((name) => path.join(catDir, name))
      .filter((p) => fs.existsSync(p));
  }

  /**
   * Отправляет каждый файл счёта категории на анализ столбцов через RouterAI
   * (всегда режим HARD, см. RouterAIService.extractBillColumns) и агрегирует результаты,
   * если для одной категории найдено несколько файлов счёта.
   */
  private async aggregateCategoryColumns(
    category: SpravkaCategory,
    billFiles: string[]
  ): Promise<{ aggregated: AggregatedBillColumns; warnings: string[] }> {
    const warnings: string[] = [];
    const extracted: BillColumnsExtractResult[] = [];

    for (const filePath of billFiles) {
      console.log(
        `[Роутер] Анализ столбцов счёта (${category}) — ${path.basename(filePath)}: режим HARD. Модель — RouterAI (${routerAIService.getModelName()})`
      );
      try {
        const result = await routerAIService.extractBillColumns(filePath);
        if (result.error) {
          warnings.push(`Не удалось извлечь данные из "${path.basename(filePath)}": ${result.error}`);
        }
        extracted.push(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Ошибка анализа счёта "${path.basename(filePath)}": ${msg}`);
      }
    }

    const sumOrNull = (values: Array<number | null>): number | null => {
      const nonNull = values.filter((v): v is number => typeof v === 'number');
      return nonNull.length > 0 ? nonNull.reduce((a, b) => a + b, 0) : null;
    };
    const firstNonNull = <T,>(values: Array<T | null>): T | null => values.find((v) => v !== null) ?? null;

    const amount = sumOrNull(extracted.map((e) => e.amount));
    const vatAmount = sumOrNull(extracted.map((e) => e.vatAmount));
    const totalWithVat = sumOrNull(extracted.map((e) => e.totalWithVat));
    const quantity = sumOrNull(extracted.map((e) => e.quantity));
    const unit = firstNonNull(extracted.map((e) => e.unit));
    const vatPercent = firstNonNull(extracted.map((e) => e.vatPercent));
    const pricePerUnit =
      extracted.length === 1
        ? extracted[0].pricePerUnit
        : amount !== null && quantity && quantity > 0
          ? Math.round((amount / quantity) * 100000) / 100000
          : firstNonNull(extracted.map((e) => e.pricePerUnit));

    return {
      aggregated: { unit, quantity, pricePerUnit, amount, vatPercent, vatAmount, totalWithVat },
      warnings
    };
  }

  /**
   * Заменяет месяц и год в тексте вида "... за <месяц> <год> г)", "... за <месяц> <год> г."
   * или "... за <месяц> <год> г (...)" на месяц, предшествующий текущему.
   * Не трогает символы после "г" (закрывающую скобку, точку, вложенный список услуг и т.п.).
   */
  private buildRowReplacement(cellText: string, date: Date): string {
    const prevMonthIndex = (date.getMonth() - 1 + 12) % 12;
    const prevMonthName = MONTH_NAMES_LOWER[prevMonthIndex];
    const year = date.getFullYear();
    return cellText.replace(/за\s+[а-яёА-ЯЁ]+\s+\d{4}\s*г/i, `за ${prevMonthName} ${year} г`);
  }

  /**
   * Заполняет "справка-расчет.docx": дату справки, месяц оказания услуг в наименованиях строк таблицы
   * и столбцы (единица измерения, количество, цена, сумма, НДС%, сумма НДС, всего с НДС) по данным,
   * извлечённым моделью (всегда HARD-режим через RouterAI) из соответствующих файлов счетов текущего месяца.
   * В конце пересчитывает итоговую сумму и её расшифровку словами. Сохраняет результат в pdf и удаляет .docx.
   */
  async fillAndConvertSpravkaDoc(
    monthDir: string,
    excludeCategories: SpravkaCategory[] = [],
    date: Date = new Date()
  ): Promise<FillSpravkaDocResult> {
    const docPath = path.join(monthDir, 'справка-расчет.docx');
    if (!fs.existsSync(docPath)) {
      throw new Error(`Файл справки-расчёта не найден: ${docPath}`);
    }

    const orgMonthDir = getCurrentOrganizeBillsMonthDir();
    const warnings: string[] = [];
    const columnsByCategory: Partial<Record<SpravkaCategory, AggregatedBillColumns>> = {};
    const categoriesFilled: SpravkaCategory[] = [];
    const excludedSet = new Set(excludeCategories);

    for (const { category } of SPRAVKA_ROW_CATEGORY_KEYWORDS) {
      if (excludedSet.has(category)) {
        warnings.push(`Категория "${category}" исключена из счёта — квитанция об оплате не найдена (продолжено принудительно).`);
        continue;
      }
      const billFiles = this.getBillFilesForCategory(orgMonthDir, category);
      if (billFiles.length === 0) {
        warnings.push(`Не найдены файлы счёта для категории "${category}" — столбцы таблицы не заполнены.`);
        continue;
      }
      const { aggregated, warnings: catWarnings } = await this.aggregateCategoryColumns(category, billFiles);
      warnings.push(...catWarnings);
      columnsByCategory[category] = aggregated;
      categoriesFilled.push(category);
    }

    const buffer = fs.readFileSync(docPath);
    const zip = await JSZip.loadAsync(buffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      throw new Error('В .docx-файле не найден word/document.xml — файл повреждён или не является .docx.');
    }
    let documentXml = await documentXmlFile.async('string');

    const dateLineRegex = /«\d{1,2}»\s*[а-яёА-ЯЁ]+\s+\d{4}\s*г\./;
    documentXml = replaceFirstMatchingParagraph(
      documentXml,
      (text) => dateLineRegex.test(text),
      (paragraphXml) => {
        const currentText = extractCellTexts(paragraphXml).join('');
        const newText = currentText.replace(dateLineRegex, this.buildBillDateReplacement(date));
        return replaceParagraphText(paragraphXml, newText);
      }
    );

    const { table, start, end } = extractLastTable(documentXml);
    const rows = extractRows(table);
    if (rows.length === 0) {
      throw new Error('В таблице справки-расчёта не найдено строк.');
    }

    const newRows: string[] = [];
    let totalWithVat = 0;

    for (const rowXml of rows) {
      const cells = extractCells(rowXml);
      const nameText = cells.length > 1 ? extractCellTexts(cells[1]).join('') : '';
      const matched = SPRAVKA_ROW_CATEGORY_KEYWORDS.find((k) => nameText.includes(k.keyword));

      if (!matched) {
        newRows.push(rowXml);
        continue;
      }

      if (excludedSet.has(matched.category)) {
        // Категория без квитанции об оплате — строка полностью исключается из итогового счёта.
        continue;
      }

      const agg = columnsByCategory[matched.category];
      const newCells = [...cells];
      newCells[1] = setCellText(cells[1], this.buildRowReplacement(nameText, date));

      const columnSetters: Array<[number, string]> = [
        [SPRAVKA_COLUMN_UNIT_INDEX, agg?.unit ?? ''],
        [SPRAVKA_COLUMN_QUANTITY_INDEX, typeof agg?.quantity === 'number' ? formatNumberRu(agg.quantity) : ''],
        [SPRAVKA_COLUMN_PRICE_INDEX, typeof agg?.pricePerUnit === 'number' ? formatNumberRu(agg.pricePerUnit) : ''],
        [SPRAVKA_COLUMN_AMOUNT_INDEX, typeof agg?.amount === 'number' ? formatAmount(agg.amount) : ''],
        [SPRAVKA_COLUMN_VAT_PERCENT_INDEX, typeof agg?.vatPercent === 'number' ? formatNumberRu(agg.vatPercent) : ''],
        [SPRAVKA_COLUMN_VAT_AMOUNT_INDEX, typeof agg?.vatAmount === 'number' ? formatAmount(agg.vatAmount) : ''],
        [SPRAVKA_COLUMN_TOTAL_INDEX, typeof agg?.totalWithVat === 'number' ? formatAmount(agg.totalWithVat) : '']
      ];

      for (const [colIdx, text] of columnSetters) {
        if (colIdx >= cells.length) continue;
        newCells[colIdx] = setCellText(cells[colIdx], text);
      }

      if (typeof agg?.totalWithVat === 'number') {
        totalWithVat += agg.totalWithVat;
      }

      const trOpen = rowOpeningTag(rowXml);
      newRows.push(`${trOpen}${newCells.join('')}</w:tr>`);
    }

    // Обновляем итоговую сумму в последней ячейке строки "Итого:".
    const totalRowIdx = newRows.length - 1;
    const totalRowCells = extractCells(newRows[totalRowIdx]);
    if (totalRowCells.length > 0) {
      const lastIdx = totalRowCells.length - 1;
      const updatedCells = totalRowCells.map((c, i) =>
        i === lastIdx ? setCellText(c, formatAmount(totalWithVat)) : c
      );
      const trOpen = rowOpeningTag(newRows[totalRowIdx]);
      newRows[totalRowIdx] = `${trOpen}${updatedCells.join('')}</w:tr>`;
    }

    const tblPrEnd = table.indexOf('</w:tblGrid>');
    const preamble = tblPrEnd !== -1 ? table.slice(0, tblPrEnd + '</w:tblGrid>'.length) : '<w:tbl>';
    const newTable = `${preamble}${newRows.join('')}</w:tbl>`;
    documentXml = documentXml.slice(0, start) + newTable + documentXml.slice(end);

    documentXml = replaceFirstMatchingParagraph(
      documentXml,
      (text) => text.includes('Сумма прописью'),
      (paragraphXml) => replaceParagraphValueAfterLabel(paragraphXml, 'Сумма прописью:', amountToWordsRu(totalWithVat))
    );

    zip.file('word/document.xml', documentXml);
    const outBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(docPath, outBuffer);

    try {
      const pdfPath = this.convertDocxToPdf(docPath);
      return { pdfPath, totalWithVat, categoriesFilled, warnings };
    } finally {
      if (fs.existsSync(docPath)) {
        fs.unlinkSync(docPath);
      }
    }
  }

  /**
   * Заполняет "счет коммуналка.docx": дату счёта (строка "СЧЁТ № 2 от ..."),
   * месяц оказания услуг в ячейке таблицы ("Оплата коммунальных услуг за ... 2026 г (...)"),
   * а итоговую сумму и её расшифровку словами — на готовые значения, уже рассчитанные
   * в справке-расчёте (не пересчитывая их заново по счётам). Само таблица содержит
   * одну сводную строку по всем коммунальным услугам и не разбивается по категориям,
   * поэтому столбцы сумм не анализируются повторно — передаются готовая итоговая сумма справки-расчёта.
   * Больше никакие данные в документе не меняются. Сохраняет результат в pdf и удаляет .docx.
   */
  async fillAndConvertKommunalkaDoc(
    monthDir: string,
    totalWithVat: number,
    date: Date = new Date()
  ): Promise<FillKommunalkaDocResult> {
    const docPath = path.join(monthDir, 'счет коммуналка.docx');
    if (!fs.existsSync(docPath)) {
      throw new Error(`Файл счёта-коммуналки не найден: ${docPath}`);
    }

    const buffer = fs.readFileSync(docPath);
    const zip = await JSZip.loadAsync(buffer);
    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      throw new Error('В .docx-файле не найден word/document.xml — файл повреждён или не является .docx.');
    }
    let documentXml = await documentXmlFile.async('string');

    const dateLineRegex = /«\d{1,2}»\s*[а-яёА-ЯЁ]+\s+\d{4}\s*г\./;
    documentXml = replaceFirstMatchingParagraph(
      documentXml,
      (text) => dateLineRegex.test(text),
      (paragraphXml) => {
        const currentText = extractCellTexts(paragraphXml).join('');
        const newText = currentText.replace(dateLineRegex, this.buildBillDateReplacement(date));
        return replaceParagraphText(paragraphXml, newText);
      }
    );

    const serviceMonthRegex = /Оплата коммунальных услуг за\s+[а-яёА-ЯЁ]+\s+\d{4}\s*г/;
    documentXml = replaceFirstMatchingParagraph(
      documentXml,
      (text) => serviceMonthRegex.test(text),
      (paragraphXml) => {
        const currentText = extractCellTexts(paragraphXml).join('');
        const newText = this.buildRowReplacement(currentText, date);
        return replaceParagraphText(paragraphXml, newText);
      }
    );

    const { table, start, end } = extractLastTable(documentXml);
    const rows = extractRows(table);
    if (rows.length === 0) {
      throw new Error('В таблице счёта-коммуналки не найдено строк.');
    }

    // Обновляем итоговую сумму в строках "строка услуги" и "Итого:" (обе содержат одинаковую сумму в последней ячейке).
    const newRows = rows.map((rowXml) => {
      const cells = extractCells(rowXml);
      if (cells.length === 0) return rowXml;
      const lastIdx = cells.length - 1;
      const newCells = cells.map((c, i) => (i === lastIdx ? setCellText(c, formatAmount(totalWithVat)) : c));
      const trOpen = rowOpeningTag(rowXml);
      return `${trOpen}${newCells.join('')}</w:tr>`;
    });

    const tblPrEnd = table.indexOf('</w:tblGrid>');
    const preamble = tblPrEnd !== -1 ? table.slice(0, tblPrEnd + '</w:tblGrid>'.length) : '<w:tbl>';
    const newTable = `${preamble}${newRows.join('')}</w:tbl>`;
    documentXml = documentXml.slice(0, start) + newTable + documentXml.slice(end);

    documentXml = replaceFirstMatchingParagraph(
      documentXml,
      (text) => text.includes('Сумма прописью'),
      (paragraphXml) => replaceParagraphValueAfterLabel(paragraphXml, 'Сумма прописью:', amountToWordsRu(totalWithVat))
    );

    zip.file('word/document.xml', documentXml);
    const outBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(docPath, outBuffer);

    try {
      const pdfPath = this.convertDocxToPdf(docPath);
      return { pdfPath };
    } finally {
      if (fs.existsSync(docPath)) {
        fs.unlinkSync(docPath);
      }
    }
  }
}

export const sordisuBillGeneratorService = new SordisuBillGeneratorService();

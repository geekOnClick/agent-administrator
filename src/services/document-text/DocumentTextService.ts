import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Извлечение текста из документов счетов и определение, текстовый это документ
 * или скан/изображение.
 *
 * Маршрутизация парсера итогов (Фаза 1):
 *   - текстовый PDF / DOC / DOCX / XLS / XLSX / ODT  → детерминированный парсер
 *     по извлечённому тексту (pdftotext -layout, LibreOffice → PDF → pdftotext,
 *     LibreOffice → CSV для XLS);
 *   - скан/фото: PDF без текста, JPG/JPEG/PNG          → модель (RouterAI, OCR)
 *     с усиленным промптом-схемой.
 *
 * Это устраняет ошибку «модель берёт не ту колонку» для текстовых счетов
 * (основной источник проблемы, в т.ч. для XLS-реестров) и оставляет модели
 * только genuinely-визуальные кейсы (сканы).
 */

export type DocumentKind = 'text' | 'image' | 'empty';

export interface ExtractedDocument {
  kind: DocumentKind;
  /** Извлечённый текст (для text/empty). Пустая строка для image. */
  text: string;
  /** Пути к PNG страниц — только для kind === 'image' (рендер скана для модели). */
  imagePaths?: string[];
  /** Исходный путь. */
  filePath: string;
}

const TEXT_PDF_MIN_NONSPACE_CHARS = 30;

/** Запускает LibreOffice headless в изолированном профиле, чтобы не конфликтовать с GUI soffice. */
function runLibreOffice(args: string[], outDir: string): void {
  const userInstallDir = path.join(
    os.tmpdir(),
    `lo-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const userInstallUrl = pathToFileURL(userInstallDir).toString();
  try {
    execSync(
      `libreoffice --headless --norestore "-env:UserInstallation=${userInstallUrl}" ${args.join(' ')} --outdir "${outDir}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
  } finally {
    fs.rmSync(userInstallDir, { recursive: true, force: true });
  }
}

/** Конвертация офисного документа (doc/docx/xls/xlsx/odt) во временный PDF. */
function convertOfficeToPdf(filePath: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctext-pdf-'));
  try {
    runLibreOffice([`--convert-to pdf`, `"${filePath}"`], tmpDir);
    const base = path.basename(filePath, path.extname(filePath));
    const pdfPath = path.join(tmpDir, `${base}.pdf`);
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`Конвертация в PDF не создала файл: ${pdfPath}`);
    }
    return pdfPath;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Конвертация XLS/XLSX в CSV (один лист; для реестров хватает). */
function convertXlsToCsv(filePath: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctext-csv-'));
  try {
    runLibreOffice([`--convert-to csv`, `"${filePath}"`], tmpDir);
    const base = path.basename(filePath, path.extname(filePath));
    const csvPath = path.join(tmpDir, `${base}.csv`);
    if (!fs.existsSync(csvPath)) {
      throw new Error(`Конвертация в CSV не создала файл: ${csvPath}`);
    }
    return csvPath;
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

function pdfToText(pdfPath: string): string {
  try {
    return execSync(`pdftotext -layout "${pdfPath}" -`, {
      encoding: 'utf-8',
      timeout: 60000
    });
  } catch {
    return '';
  }
}

/** Рендерит страницы PDF в PNG (для передачи скана в vision-модель). */
function pdfToPngs(pdfPath: string, outDir: string, dpi = 150): string[] {
  const prefix = path.join(outDir, 'page');
  try {
    execSync(`pdftoppm -png -r ${dpi} "${pdfPath}" "${prefix}"`, {
      stdio: 'pipe',
      timeout: 120000
    });
  } catch {
    return [];
  }
  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('page') && f.endsWith('.png'))
    .sort()
    .map((f) => path.join(outDir, f));
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp']);
const OFFICE_EXTS = new Set(['.doc', '.docx', '.rtf', '.odt']);
const SPREADSHEET_EXTS = new Set(['.xls', '.xlsx', '.ods']);

export class DocumentTextService {
  /**
   * Извлекает текст/определяет тип документа по пути.
   * Для сканов (PDF без текста, изображения) рендерит страницы в PNG.
   */
  async extract(filePath: string): Promise<ExtractedDocument> {
    const ext = path.extname(filePath).toLowerCase();

    // 1) Картинки — сразу image.
    if (IMAGE_EXTS.has(ext)) {
      return { kind: 'image', text: '', imagePaths: [filePath], filePath };
    }

    // 2) Электронные таблицы — текст из CSV (для реестров сохраняет структуру
    //    и итоговые ячейки «Итого с НДС: 2 354,66»).
    if (SPREADSHEET_EXTS.has(ext)) {
      try {
        const csvPath = convertXlsToCsv(filePath);
        const tmpDir = path.dirname(csvPath);
        try {
          const text = fs.readFileSync(csvPath, 'utf-8');
          const nonSpace = text.replace(/\s/g, '').length;
          if (nonSpace >= TEXT_PDF_MIN_NONSPACE_CHARS) {
            return { kind: 'text', text, filePath };
          }
          // Пустой/битый XLS — пробуем как PDF (мало вероятно).
          const pdfPath = convertOfficeToPdf(filePath);
          const tmpDir2 = path.dirname(pdfPath);
          try {
            const t = pdfToText(pdfPath);
            if (t.replace(/\s/g, '').length >= TEXT_PDF_MIN_NONSPACE_CHARS) {
              return { kind: 'text', text: t, filePath };
            }
            return { kind: 'empty', text: t, filePath };
          } finally {
            fs.rmSync(tmpDir2, { recursive: true, force: true });
          }
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: 'empty', text: ``, filePath, issue: msg } as ExtractedDocument;
      }
    }

    // 3) PDF — pdftotext; если текста почти нет → считаем сканом → PNG.
    if (ext === '.pdf') {
      const text = pdfToText(filePath);
      const nonSpace = text.replace(/\s/g, '').length;
      if (nonSpace >= TEXT_PDF_MIN_NONSPACE_CHARS) {
        return { kind: 'text', text, filePath };
      }
      // Скан: рендерим страницы в PNG во временной папке.
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctext-img-'));
      const imagePaths = pdfToPngs(filePath, outDir);
      if (imagePaths.length > 0) {
        return { kind: 'image', text: '', imagePaths, filePath };
      }
      fs.rmSync(outDir, { recursive: true, force: true });
      return { kind: 'empty', text, filePath };
    }

    // 4) Word/RTF/ODT — через PDF → текст.
    if (OFFICE_EXTS.has(ext)) {
      try {
        const pdfPath = convertOfficeToPdf(filePath);
        const tmpDir = path.dirname(pdfPath);
        try {
          const text = pdfToText(pdfPath);
          const nonSpace = text.replace(/\s/g, '').length;
          if (nonSpace >= TEXT_PDF_MIN_NONSPACE_CHARS) {
            return { kind: 'text', text, filePath };
          }
          return { kind: 'empty', text, filePath };
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { kind: 'empty', text: '', filePath, issue: msg } as ExtractedDocument;
      }
    }

    // 5) Прочее (txt и т.п.) — читаем как есть.
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      const nonSpace = text.replace(/\s/g, '').length;
      return { kind: nonSpace >= TEXT_PDF_MIN_NONSPACE_CHARS ? 'text' : 'empty', text, filePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: 'empty', text: '', filePath, issue: msg } as ExtractedDocument;
    }
  }
}

export const documentTextService = new DocumentTextService();
import path from 'path';
import XLSX from 'xlsx';
import fs from 'fs';
import { PDFParse } from 'pdf-parse';

export interface BillEntry {
  filePath: string;
  amount: number;
  rawText: string;
}

export interface BillsProcessingResult {
  reportPath: string;
  total: number;
  entries: { file: string; amount: number }[];
}

export class DocumentsService {
  private static readonly BILL_EXTENSIONS = new Set(['.xlsx', '.xls', '.pdf']);

  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  readFile(filePath: string): string {
    return fs.readFileSync(filePath, 'utf-8');
  }

  writeFile(filePath: string, content: string): void {
    fs.writeFileSync(filePath, content);
  }

  getResultPath(filePath: string): string {
    return path.join(
      path.dirname(filePath),
      `result_${path.basename(filePath)}`
    );
  }

  /**
   * Читает Excel-файл и возвращает текстовое представление всех листов.
   */
  readExcel(filePath: string): string {
    const workbook = XLSX.readFile(filePath);
    const lines: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t' });
      lines.push(`=== Лист: ${sheetName} ===`);
      lines.push(csv);
    }
    return lines.join('\n');
  }

  /**
   * Читает PDF-файл и возвращает текстовое содержимое.
   */
  async readPdf(filePath: string): Promise<string> {
    const buffer = fs.readFileSync(filePath);
    const uint8Array = new Uint8Array(buffer);
    // Используем @ts-ignore так как load() помечен как private в типах, 
    // но необходим для инициализации в данной версии pdf-parse
    const parser = new PDFParse(uint8Array);
    // @ts-ignore
    await parser.load();
    const data = await parser.getText();
    // @ts-ignore
    return typeof data === 'string' ? data : (data.text || '');
  }

  /**
   * Универсальное чтение документа в зависимости от расширения.
   */
  async readDocument(filePath: string): Promise<string> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
      return this.readExcel(filePath);
    } else if (ext === '.pdf') {
      return await this.readPdf(filePath);
    } else {
      return this.readFile(filePath);
    }
  }

  isSupportedBillFile(filePath: string): boolean {
    return DocumentsService.BILL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  resolveInputPath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      return trimmed;
    }

    const directResolved = path.resolve(trimmed);
    if (this.exists(directResolved)) {
      return directResolved;
    }

    // Поддержка варианта "/docs" как "docs" от корня проекта.
    if (path.isAbsolute(trimmed)) {
      const projectRelative = path.resolve(process.cwd(), trimmed.replace(/^[/\\]+/, ''));
      if (this.exists(projectRelative)) {
        return projectRelative;
      }
    }

    return directResolved;
  }

  collectBillsFromDirectory(dirPath: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.collectBillsFromDirectory(fullPath));
      } else if (entry.isFile() && this.isSupportedBillFile(fullPath)) {
        results.push(fullPath);
      }
    }

    return results;
  }

  resolveBillFilePaths(inputPaths: string[]): string[] {
    const normalizedInputs = inputPaths
      .map((p) => this.resolveInputPath(p))
      .filter(Boolean);

    if (normalizedInputs.length === 0) {
      throw new Error('Не переданы пути к счетам или папкам.');
    }

    const missing = normalizedInputs.filter((p) => !this.exists(p));
    if (missing.length > 0) {
      throw new Error(`Файлы или папки не найдены: ${missing.join(', ')}`);
    }

    const files: string[] = [];
    const unsupported: string[] = [];

    for (const inputPath of normalizedInputs) {
      const stat = fs.statSync(inputPath);
      if (stat.isDirectory()) {
        files.push(...this.collectBillsFromDirectory(inputPath));
        continue;
      }

      if (this.isSupportedBillFile(inputPath)) {
        files.push(inputPath);
      } else {
        unsupported.push(inputPath);
      }
    }

    if (unsupported.length > 0) {
      throw new Error(
        `Неподдерживаемые форматы: ${unsupported.join(', ')}. Поддерживаются: .xlsx, .xls, .pdf`
      );
    }

    const uniqueFiles = Array.from(new Set(files));
    if (uniqueFiles.length === 0) {
      throw new Error('В переданных папках не найдено файлов счетов (.xlsx, .xls, .pdf).');
    }

    return uniqueFiles;
  }

  private parseMoneyToCents(rawAmount: string): number | null {
    const compact = rawAmount.replace(/[\s\u00a0\u202f]/g, '');
    const separatorIndex = Math.max(compact.lastIndexOf(','), compact.lastIndexOf('.'));
    if (separatorIndex < 0) {
      return null;
    }

    const rubles = compact.slice(0, separatorIndex).replace(/\D/g, '');
    const kopecks = compact.slice(separatorIndex + 1).replace(/\D/g, '');
    if (!rubles || kopecks.length !== 2) {
      return null;
    }

    return Number(rubles) * 100 + Number(kopecks);
  }

  private maybeFixMojibake(text: string): string {
    const originalCyrillicCount = (text.match(/[А-Яа-яЁё]/g) || []).length;
    const repaired = Buffer.from(text, 'latin1').toString('utf-8');
    const repairedCyrillicCount = (repaired.match(/[А-Яа-яЁё]/g) || []).length;

    return repairedCyrillicCount > originalCyrillicCount ? repaired : text;
  }

  private extractMoneyValues(line: string): number[] {
    const moneyPattern =
      /(?:^|[^\d])((?:\d{1,3}(?:[\s\u00a0\u202f,']\d{3})+|\d+)[,.]\d{2})(?!\d|[,.]\d)/g;
    const values: number[] = [];
    let match: RegExpExecArray | null;

    while ((match = moneyPattern.exec(line)) !== null) {
      const cents = this.parseMoneyToCents(match[1]);
      if (cents !== null && cents > 0) {
        values.push(cents);
      }
    }

    return values;
  }

  private extractAmountCents(text: string): number {
    const normalized = this.maybeFixMojibake(text)
      .replace(/[\u00a0\u202f]/g, ' ')
      .replace(/\r\n?/g, '\n');
    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const priorityGroups = [
      /(?:всего\s+к\s+оплате|итого\s+к\s+оплате|к\s+оплате|итого\s+с\s+ндс|всего\s+с\s+ндс|âñåãî\s+ê\s+îïëàòå|èòîãî\s+ê\s+îïëàòå|èòîãî\s+ñ\s+íäñ|âñåãî\s+ñ\s+íäñ)/i,
      /(?:итого|всего|ндс|total|amount|sum|èòîãî|âñåãî|íäñ)/i
    ];

    for (const pattern of priorityGroups) {
      const candidates: number[] = [];

      for (const line of lines) {
        if (!pattern.test(line)) {
          continue;
        }

        const values = this.extractMoneyValues(line);
        if (values.length > 0) {
          candidates.push(values[values.length - 1]);
        }
      }

      if (candidates.length > 0) {
        return candidates[candidates.length - 1];
      }
    }

    const fallback = this.extractMoneyValues(normalized);
    return fallback.length > 0 ? Math.max(...fallback) : 0;
  }

  /**
   * Обрабатывает список файлов-счетов, возвращает суммы по каждому
   * и итоговую сумму.
   */
  async processBills(filePaths: string[]): Promise<{
    entries: BillEntry[];
    total: number;
  }> {
    const entries: BillEntry[] = [];
    let totalCents = 0;

    for (const filePath of filePaths) {
      const rawText = await this.readDocument(filePath);
      const amountCents = this.extractAmountCents(rawText);
      const amount = amountCents / 100;
      totalCents += amountCents;
      entries.push({ filePath, amount, rawText });
    }

    const total = totalCents / 100;
    return { entries, total };
  }

  /**
   * Формирует текстовый отчёт об итоговой сумме и записывает его в файл.
   */
  writeBillsReport(
    outputPath: string,
    entries: BillEntry[],
    total: number
  ): void {
    const now = new Date().toLocaleString('ru-RU');
    const lines: string[] = [
      `Отчёт по счетам на оплату коммунальных услуг`,
      `Дата формирования: ${now}`,
      ``,
      `Детализация:`,
    ];

    for (const entry of entries) {
      const name = path.basename(entry.filePath);
      const amountStr =
        entry.amount > 0
          ? entry.amount.toFixed(2) + ' руб.'
          : 'сумма не определена';
      lines.push(`  - ${name}: ${amountStr}`);
    }

    lines.push(``);
    lines.push(`ИТОГО К ОПЛАТЕ: ${total.toFixed(2)} руб.`);

    this.writeFile(outputPath, lines.join('\n'));
  }

  async processFile(
    filePath: string,
    transform: (content: string) => Promise<string>
  ): Promise<string> {
    if (!this.exists(filePath)) {
      throw new Error(`Файл ${filePath} не найден.`);
    }

    const content = this.readFile(filePath);
    const result = await transform(content);
    const newFilePath = this.getResultPath(filePath);
    this.writeFile(newFilePath, result);

    return newFilePath;
  }

  async processUtilityBills(
    inputPaths: string[],
    outputPath?: string
  ): Promise<BillsProcessingResult> {
    const billFiles = this.resolveBillFilePaths(inputPaths);

    console.log(`\n📄 Обработка ${billFiles.length} счёт(ов)...`);

    const { entries, total } = await this.processBills(billFiles);

    for (const entry of entries) {
      const name = path.basename(entry.filePath);
      const amountStr =
        entry.amount > 0 ? `${entry.amount.toFixed(2)} руб.` : 'сумма не определена';
      console.log(`  ✅ ${name}: ${amountStr}`);
    }
    console.log(`  💰 ИТОГО: ${total.toFixed(2)} руб.`);

    const resolvedOutputPath =
      outputPath ||
      path.join(path.dirname(billFiles[0]), `bills_report_${Date.now()}.txt`);

    this.writeBillsReport(
      resolvedOutputPath,
      entries,
      total
    );

    return {
      reportPath: resolvedOutputPath,
      total,
      entries: entries.map((e) => ({ file: e.filePath, amount: e.amount }))
    };
  }
}

import path from 'path';
import fs from 'fs';

export class DocumentsService {
  private static readonly BILL_EXTENSIONS = new Set(['.xlsx', '.xls', '.pdf', '.doc', '.docx', '.odt']);

  exists(filePath: string): boolean {
    return fs.existsSync(filePath);
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
    const normalizedInputs = inputPaths.map((p) => this.resolveInputPath(p)).filter(Boolean);

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
        `Неподдерживаемые форматы: ${unsupported.join(', ')}. Поддерживаются: .xlsx, .xls, .pdf, .doc, .docx`
      );
    }

    const uniqueFiles = Array.from(new Set(files));
    if (uniqueFiles.length === 0) {
      throw new Error(
        'В переданных папках не найдено файлов счетов (.xlsx, .xls, .pdf, .doc, .docx).'
      );
    }

    return uniqueFiles;
  }
}

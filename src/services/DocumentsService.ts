import fs from 'fs';
import path from 'path';

export class DocumentsService {
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
}

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { BILLS_WITH_MODEL_SYSTEM_PROMPT } from '../llm/prompts/profiles.js';

interface RouterAIContentPart {
  type: 'text' | 'file' | 'image_url';
  text?: string;
  file?: { filename: string; file_data: string };
  image_url?: { url: string };
}

interface RouterAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | RouterAIContentPart[];
}

interface RouterAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
      annotations?: Array<{
        type: 'file';
        file: {
          hash: string;
          name?: string;
          content: Array<RouterAIContentPart>;
        };
      }>;
    };
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class RouterAIService {
  private apiKey: string;
  private model: string;
  private apiUrl: string;

  constructor() {
    this.apiKey = process.env.AIROUTER_API_KEY || '';
    this.model = process.env.AIROUTER_MODEL || 'google/gemini-3-flash';
    this.apiUrl = process.env.ROUTERAI_API_URL || 'https://routerai.ru/api/v1/chat/completions';
    if (!this.apiKey) {
      throw new Error('AIROUTER_API_KEY не задан в .env');
    }
  }

  private toBase64(filePath: string): string {
    return fs.readFileSync(filePath).toString('base64');
  }

  private isPdf(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.pdf';
  }

  private convertToPdf(filePath: string): string {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, path.extname(filePath));
    const outPath = path.join(dir, `${baseName}.pdf`);
    if (fs.existsSync(outPath)) {
      fs.unlinkSync(outPath);
    }
    try {
      execSync(`libreoffice --headless --convert-to pdf --outdir "${dir}" "${filePath}"`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    } catch (err) {
      throw new Error(`Ошибка конвертации ${filePath} в PDF: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!fs.existsSync(outPath)) {
      throw new Error(`Конвертация не создала файл: ${outPath}`);
    }
    // Удаляем исходный файл после успешной конвертации,
    // чтобы при повторном запуске в контекст не попадали дубликаты
    fs.unlinkSync(filePath);
    return outPath;
  }

  private buildFilePart(filePath: string): RouterAIContentPart {
    const filename = path.basename(filePath);
    if (this.isPdf(filePath)) {
      const b64 = this.toBase64(filePath);
      return {
        type: 'file',
        file: {
          filename,
          file_data: `data:application/pdf;base64,${b64}`,
        },
      };
    }
    const pdfPath = this.convertToPdf(filePath);
    const b64 = this.toBase64(pdfPath);
    return {
      type: 'file',
      file: {
        filename: path.basename(pdfPath),
        file_data: `data:application/pdf;base64,${b64}`,
      },
    };
  }

  async processBillsWithFiles(
    filePaths: string[],
    outputDir?: string
  ): Promise<{ reply: string; reportPath: string }> {
    const contentParts: RouterAIContentPart[] = [];
    const convertedFiles: string[] = [];

    for (const filePath of filePaths) {
      try {
        const part = this.buildFilePart(filePath);
        contentParts.push(part);
        if (!this.isPdf(filePath)) {
          convertedFiles.push(part.file!.filename);
        }
      } catch (err) {
        console.error(`Пропускаю файл ${filePath}:`, err);
      }
    }

    if (contentParts.length === 0) {
      throw new Error('Не удалось подготовить ни одного файла для отправки');
    }

    contentParts.unshift({
      type: 'text',
      text: `Проанализируй приложенные счета (${filePaths.length} шт.). Извлеки итоговые суммы и вычисли общую сумму по всем документам.`,
    });

    const messages: RouterAIMessage[] = [
      { role: 'system', content: BILLS_WITH_MODEL_SYSTEM_PROMPT },
      { role: 'user', content: contentParts },
    ];

    const body = {
      model: this.model,
      messages,
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
    };

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`RouterAI API error ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as RouterAIResponse;
    const reply = data.choices?.[0]?.message?.content || 'Пустой ответ от модели';

    const timestamp = Date.now();
    const targetDir = outputDir || process.cwd();
    const reportPath = path.resolve(targetDir, `bills_with_model_report_${timestamp}.txt`);
    const reportContent = `Источник: routerai (${this.model})
Дата: ${new Date().toISOString()}
Файлов обработано: ${filePaths.length}
Конвертировано в PDF: ${convertedFiles.length}

${reply}
`;
    fs.writeFileSync(reportPath, reportContent, 'utf8');

    return { reply, reportPath };
  }
}

export const routerAIService = new RouterAIService();

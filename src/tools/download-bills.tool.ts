import path from 'node:path';
import { z } from 'zod';
import { YandexDiskService } from '../services/YandexDiskService.js';
import type { AgentTool } from './types.js';

export const downloadBillsSchema = z.object({
  docsDir: z.string().optional().describe('Путь к папке docs (по умолчанию ./docs)')
});

export type DownloadBillsInput = z.output<typeof downloadBillsSchema>;

export interface DownloadBillsResult {
  success: boolean;
  docsDir: string;
  fileCount: number;
  filePaths: string[];
  fileNames: string[];
}

const yandexDiskService = new YandexDiskService();

export const downloadBillsTool: AgentTool<typeof downloadBillsSchema, DownloadBillsResult> = {
  name: 'download_bills_from_yandex',
  title: 'Скачать счета с Яндекс.Диска',
  description:
    'Скачивает документы (счета) из публичной папки Яндекс.Диска и сохраняет их в локальную папку docs. ' +
    'Перед скачиванием очищает папку docs от предыдущего содержимого.',
  schema: downloadBillsSchema,

  async execute({ docsDir }): Promise<DownloadBillsResult> {
    const resolvedDir = docsDir ? path.resolve(docsDir) : path.resolve(process.cwd(), 'docs');
    const files = await yandexDiskService.syncDocsToLocal(resolvedDir);
    return {
      success: true,
      docsDir: resolvedDir,
      fileCount: files.length,
      filePaths: files,
      fileNames: files.map((f) => path.basename(f))
    };
  }
};

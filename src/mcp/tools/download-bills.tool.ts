import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import { YandexDiskService } from '../../services/YandexDiskService.js';

export const downloadBillsInputSchema = {
  docsDir: z.string().optional().describe('Путь к папке docs (по умолчанию ./docs)')
};

export function registerDownloadBillsTool(server: McpServer): void {
  const yandexDiskService = new YandexDiskService();

  server.registerTool(
    'download_bills_from_yandex',
    {
      title: 'Скачать счета с Яндекс.Диска',
      description:
        'Скачивает документы (счета) из публичной папки Яндекс.Диска и сохраняет их в локальную папку docs. ' +
        'Перед скачиванием очищает папку docs от предыдущего содержимого.',
      inputSchema: downloadBillsInputSchema
    },
    async (req) => {
      try {
        const docsDir = req.docsDir
          ? path.resolve(req.docsDir)
          : path.resolve(process.cwd(), 'docs');

        const files = await yandexDiskService.syncDocsToLocal(docsDir);

        const fileNames = files.map((f) => path.basename(f));

        return {
          content: [
            {
              type: 'text',
              text:
                `Успешно скачано документов: ${files.length}\n` +
                `Папка: ${docsDir}\n` +
                `Файлы:\n${fileNames.map((n, i) => `  ${i + 1}. ${n}`).join('\n')}`
            }
          ],
          structuredContent: {
            success: true,
            docsDir,
            fileCount: files.length,
            filePaths: files,
            fileNames
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Ошибка скачивания документов с Яндекс.Диска: ${message}`
            }
          ],
          structuredContent: {
            success: false,
            error: message
          }
        };
      }
    }
  );
}

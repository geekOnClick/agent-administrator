import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocumentsService } from '../../services/DocumentsService.js';

export const processBillsInputSchema = {
  paths: z.array(z.string()).describe('Пути к файлам/папкам со счетами'),
  outputPath: z.string().optional().describe('Необязательный путь для отчета')
};

export const readBillsContentInputSchema = {
  paths: z.array(z.string()).describe('Пути к файлам/папкам со счетами')
};

export function registerReadBillsContentTool(
  server: McpServer,
  docsService: DocumentsService
): void {
  server.registerTool(
    'read_bills_content',
    {
      title: 'Прочитать содержимое счетов',
      description:
        'Прочитать xlsx/xls/pdf/doc/docx счета и вернуть их текстовое содержимое для анализа моделью',
      inputSchema: readBillsContentInputSchema
    },
    async (req) => {
      try {
        const { files, totalChars } = await docsService.readBillsForModel(req.paths);

        const content = files
          .map(
            (f, i) =>
              `=== ДОКУМЕНТ ${i + 1}: ${f.filePath} ===\n${f.content}\n=== КОНЕЦ ДОКУМЕНТА ${i + 1} ===`
          )
          .join('\n\n');

        return {
          content: [
            {
              type: 'text',
              text:
                `Прочитано документов: ${files.length}\n` +
                `Общий объем: ${totalChars} символов\n\n` +
                content
            }
          ],
          structuredContent: {
            fileCount: files.length,
            totalChars,
            files: files.map((f) => ({ path: f.filePath, chars: f.content.length }))
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Ошибка чтения счетов: ${String(error)}` }]
        };
      }
    }
  );
}

export function registerProcessBillsTool(server: McpServer, docsService: DocumentsService): void {
  server.registerTool(
    'process_bills',
    {
      title: 'Обработать счета',
      description:
        'Найти итоговые суммы в xlsx/xls/pdf/doc/docx счетах, посчитать ИТОГО и сохранить отчет в файл',
      inputSchema: processBillsInputSchema
    },
    async (req) => {
      try {
        const result = await docsService.processUtilityBills(req.paths, req.outputPath);
        const details = result.entries
          .map((entry, i) => `${i + 1}. ${entry.file}: ${entry.amount.toFixed(2)} руб.`)
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text:
                `ИТОГО К ОПЛАТЕ: ${result.total.toFixed(2)} руб.\n` +
                `Отчет: ${result.reportPath}\n` +
                `Детализация:\n${details}`
            }
          ],
          structuredContent: {
            reportPath: result.reportPath,
            total: result.total,
            entries: result.entries
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Ошибка обработки счетов: ${String(error)}` }]
        };
      }
    }
  );
}

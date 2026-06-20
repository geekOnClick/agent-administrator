import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocumentsService } from '../../services/DocumentsService.js';

export const processBillsInputSchema = {
  paths: z.array(z.string()).describe('Пути к файлам/папкам со счетами'),
  outputPath: z.string().optional().describe('Необязательный путь для отчета')
};

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

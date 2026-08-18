import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { receiptVerificationService } from '../../services/ReceiptVerificationService.js';

export const checkBillReceiptsInputSchema = {
  monthDir: z
    .string()
    .optional()
    .describe('Путь к папке месяца со счетами (по умолчанию папка текущего месяца)')
};

export function registerCheckBillReceiptsTool(server: McpServer): void {
  server.registerTool(
    'check_bill_receipts',
    {
      title: 'Проверить квитанции об оплате счетов',
      description:
        'Проверяет, что в каждой папке (куда organize_bills разложил счета) фактически присутствует квитанция/чек об оплате ' +
        '(суммы не сравниваются). Посторонние документы (УПД, акты и т.п.) игнорируются. Для каждого файла-кандидата ' +
        'встроенный роутер выбирает модель: EASY — локальная Ollama (gemma), HARD — RouterAI (сканы/изображения или ' +
        'сложные случаи). Выбранная для каждого файла модель логируется в консоль.',
      inputSchema: checkBillReceiptsInputSchema
    },
    async (req) => {
      try {
        const result = req.monthDir
          ? await receiptVerificationService.checkAllFolders(req.monthDir)
          : await receiptVerificationService.checkAllFolders();

        const lines = result.checkedFolders.map((f) => {
          const status = f.ok ? '✅' : '❌';
          const issue = f.issue ? ` — ${f.issue}` : '';
          return `${status} ${f.category} (${f.dir}): квитанции найдены (${f.receiptFiles.length})${issue}`;
        });

        return {
          content: [
            {
              type: 'text',
              text:
                (result.ok
                  ? '✅ Во всех папках найдены квитанции об оплате.\n'
                  : '❌ В одной или нескольких папках отсутствует квитанция об оплате.\n') + lines.join('\n')
            }
          ],
          structuredContent: result as unknown as Record<string, unknown>
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Ошибка проверки квитанций: ${String(error)}` }]
        };
      }
    }
  );
}

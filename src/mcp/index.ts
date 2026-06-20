import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DocumentsService } from '../services/DocumentsService.js';
import { AIHelperProvider, AIProvider } from '../llm/provider-factory.js';

const docsService = new DocumentsService();
const providerType = (process.env.AI_PROVIDER as AIProvider) || AIProvider.OLLAMA;
const ai = AIHelperProvider.getAiProvider(providerType);

const server = new McpServer({
  name: 'ai-assistant-server',
  version: '1.0.0'
});


server.registerTool(
  'process_bills',
  {
    title: 'Обработать счета',
    description:
      'Найти итоговые суммы в xlsx/xls/pdf счетах, посчитать ИТОГО и сохранить отчет в файл',
    inputSchema: {
      paths: z.array(z.string()).describe('Пути к файлам/папкам со счетами'),
      outputPath: z.string().optional().describe('Необязательный путь для отчета')
    }
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


async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('AI MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DocumentsService } from '../services/DocumentsService.js';
import { AIHelperProvider, AIProvider } from '../ai/connector/provider.js';

const docsService = new DocumentsService();
const providerType = (process.env.AI_PROVIDER as AIProvider) || AIProvider.OLLAMA;
const ai = AIHelperProvider.getAiProvider(providerType);

const server = new McpServer({
  name: 'ai-assistant-server',
  version: '1.0.0'
});

server.registerTool(
  'ask_ai',
  {
    title: 'Задать вопрос AI',
    description: 'Задать вопрос подключенной языковой модели',
    inputSchema: {
      prompt: z.string().describe('Текст запроса')
    }
  },
  async (req) => {
    try {
      const result = await ai.simpleChat('mcp-tool-session', req.prompt);
      return { content: [{ type: 'text', text: result }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: String(error) }] };
    }
  }
);

server.registerTool(
  'process_file',
  {
    title: 'Обработать файл',
    description:
      'Прочитать файл, обработать его содержимое моделью и сохранить результат в новый файл',
    inputSchema: {
      filePath: z.string().describe('Путь к файлу для обработки')
    }
  },
  async (req) => {
    try {
      if (!docsService.exists(req.filePath)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Файл не найден: ${req.filePath}` }]
        };
      }

      const content = docsService.readFile(req.filePath);
      const prompt = `В документе ниже содержится текст или пример. Пожалуйста, дополни его ответом или решением. Верни ТОЛЬКО итоговый текст, который должен быть в файле.\n\nСодержимое файла:\n${content}`;
      const result = await ai.simpleChat('mcp-tool-session', prompt);
      const newFilePath = docsService.getResultPath(req.filePath);

      docsService.writeFile(newFilePath, result);

      return {
        content: [
          {
            type: 'text',
            text: `Файл успешно обработан. Результат сохранен в ${newFilePath}\n\nСодержимое:\n${result}`
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Ошибка обработки файла: ${String(error)}` }]
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

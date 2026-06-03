import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import ollama from 'ollama';
import * as fs from 'fs';
import * as path from 'path';

const MODEL = 'gemma4:e4b-8k';

const server = new Server(
  {
    name: "ollama-gemma-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ask_gemma",
        description: "Задать вопрос локальной модели Gemma 4",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Текст запроса",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "process_file",
        description: "Прочитать файл, обработать его содержимое моделью и сохранить результат в новый файл",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Путь к файлу для обработки",
            },
          },
          required: ["filePath"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "ask_gemma") {
    const prompt = String(args?.prompt);
    try {
      const response = await ollama.chat({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
      });
      return { content: [{ type: "text", text: response.message.content }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: String(error) }] };
    }
  }

  if (name === "process_file") {
    const filePath = String(args?.filePath);
    try {
      if (!fs.existsSync(filePath)) {
        return { isError: true, content: [{ type: "text", text: `Файл не найден: ${filePath}` }] };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const prompt = `В документе ниже содержится текст или пример. Пожалуйста, дополни его ответом или решением. Верни ТОЛЬКО итоговый текст, который должен быть в файле.\n\nСодержимое файла:\n${content}`;

      const response = await ollama.chat({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
      });

      const result = response.message.content;
      const newFilePath = path.join(
        path.dirname(filePath),
        `result_${path.basename(filePath)}`
      );

      fs.writeFileSync(newFilePath, result);

      return {
        content: [
          {
            type: "text",
            text: `Файл успешно обработан. Результат сохранен в ${newFilePath}\n\nСодержимое:\n${result}`,
          },
        ],
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `Ошибка обработки файла: ${String(error)}` }] };
    }
  }

  throw new Error("Tool not found");
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ollama MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

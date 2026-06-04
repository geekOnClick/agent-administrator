import { AIHelperProvider, AIProvider } from './connector/provider.js';
import { AIHelperInterface, ToolDescriptor } from './connector/interface.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DocumentsService } from '../services/DocumentsService.js';
import { spawn, ChildProcess } from 'child_process';

export class ChatProcessor {
  ai: AIHelperInterface;
  private mcp: Client;
  private transport: StdioClientTransport;
  private tools: ToolDescriptor[] = [];
  private docsService = new DocumentsService();
  private ollamaProcess: ChildProcess | null = null;

  constructor() {
    let strings = Object.values(AIProvider);
    let searchElement = process.env.AI_PROVIDER || 'ollama';
    if (!strings.includes(searchElement as any)) {
      throw new Error('Wrong AI provider');
    }
    this.ai = AIHelperProvider.getAiProvider(searchElement as any);
    this.mcp = new Client({ name: 'mcp-client-cli', version: '1.0.0' });
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp/index.ts']
    });
  }

  async init() {
    // Если используем ollama, попробуем запустить процесс
    if (process.env.AI_PROVIDER === 'ollama') {
      const model = process.env.OLLAMA_MODEL || 'gemma4:e4b-8k';
      this.ollamaProcess = spawn('ollama', ['run', model], {
        stdio: 'ignore'
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await this.mcp.connect(this.transport);
    this.tools = (await this.mcp.listTools()).tools as ToolDescriptor[];
  }

  async processMessage(
    sessionId: string,
    text: string
  ): Promise<{
    message: string;
    tools: { name: string; arguments: Record<string, unknown> }[];
  }> {
    const toolsUsed: { name: string; arguments: Record<string, unknown> }[] = [];
    const finalOutput: string[] = [];

    const response = await this.ai.chatWithTools(sessionId, text, this.tools);
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        toolsUsed.push(call);

        const result = await this.mcp.callTool({
          name: call.name,
          arguments: call.arguments
        });

        const arrayResult = result.content as any[];
        const flattened = arrayResult
          .map((item) => (item.type === 'text' ? item.text : item.resource?.data || ''))
          .join('\n\n');
        // Сохраняем результат для истории с LLM
        await this.ai.storeToolResult(sessionId, {
          request: call,
          content: flattened,
          structuredContent: result.structuredContent
        });
      }
      const reply = await this.ai.simpleChat(
        sessionId,
        'Напиши мне ответ на основе результата выполнения функций, который можно было бы сразу отправить тому, кто запрашивал'
      );
      finalOutput.push(reply);
    } else {
      finalOutput.push(response.message);
    }

    return {
      message: finalOutput.join('\n'),
      tools: toolsUsed
    };
  }

  async *chatStream(sessionId: string, text: string): AsyncIterable<string> {
    if (this.ai.chatStream) {
      yield* this.ai.chatStream(sessionId, text);
    } else {
      const result = await this.processMessage(sessionId, text);
      yield result.message;
    }
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.ai.resetSession(sessionId);
  }

  /**
   * Простой запрос к AI без использования инструментов
   */
  async ask(prompt: string): Promise<string> {
    return this.ai.simpleChat('chat-processor-session', prompt);
  }

  /**
   * Обработка содержимого документа
   */
  async processDocument(content: string): Promise<string> {
    const prompt = `В документе ниже содержится текст или пример. Пожалуйста, дополни его ответом или решением. Верни ТОЛЬКО итоговый текст, который должен быть в файле.\n\nСодержимое файла:\n${content}`;
    return this.ask(prompt);
  }

  async processFile(filePath: string): Promise<string> {
    if (!this.docsService.exists(filePath)) {
      throw new Error(`Файл ${filePath} не найден.`);
    }

    const content = this.docsService.readFile(filePath);
    const result = await this.processDocument(content);
    const newFilePath = this.docsService.getResultPath(filePath);
    this.docsService.writeFile(newFilePath, result);

    return newFilePath;
  }

  async cleanup() {
    if (this.ollamaProcess) {
      this.ollamaProcess.kill();
      this.ollamaProcess = null;
    }
    try {
      await this.mcp.close();
    } catch (e) {
      // Игнорируем ошибки при закрытии
    }
  }
}

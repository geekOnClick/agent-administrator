import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import { AIHelperProvider, AIProvider } from './provider-factory.js';
import { AIHelperInterface, ToolDescriptor } from './types.js';
import { getSystemPromptByMode, LlmMode } from './prompts/profiles.js';

export class ChatProcessor {
  ai: AIHelperInterface;
  private mcp: Client;
  private transport: StdioClientTransport;
  private tools: ToolDescriptor[] = [];
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

  // инициализация модели, подключение mcp, tools
  async init() {
    const provider = process.env.AI_PROVIDER || 'ollama';
    if (provider === 'ollama') {
      const model = process.env.OLLAMA_MODEL || 'gemma4:e4b-8k';
      this.ollamaProcess = spawn('ollama', ['run', model], {
        stdio: 'ignore'
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await this.mcp.connect(this.transport);
    this.tools = (await this.mcp.listTools()).tools as ToolDescriptor[];
  }

  private async ensureModePrompt(sessionId: string, mode: LlmMode): Promise<void> {
    await this.ai.setSessionSystemPrompt(sessionId, getSystemPromptByMode(mode));
  }

  // метод для вывода сообщения модели в формате стрима
  async *chatStream(
    sessionId: string,
    text: string,
    mode: LlmMode = 'talk'
  ): AsyncIterable<string> {
    await this.ensureModePrompt(sessionId, mode);

    if (this.ai.chatStream) {
      yield* this.ai.chatStream(sessionId, text);
    } else {
      const result = await this.processMessage(sessionId, text, mode);
      // Эмуляция печатания для провайдеров без стриминга
      for (const char of result.message) {
        yield char;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  // метод для ответа в chatStream и обычного ответа в Telegram
  async processMessage(
    sessionId: string,
    text: string,
    mode: LlmMode = 'talk'
  ): Promise<{
    message: string;
    tools: { name: string; arguments: Record<string, unknown> }[];
  }> {
    await this.ensureModePrompt(sessionId, mode);

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

  async resetSession(sessionId: string): Promise<void> {
    await this.ai.resetSession(sessionId);
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

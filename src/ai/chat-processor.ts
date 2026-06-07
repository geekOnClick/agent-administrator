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
    // Если используем ollama или гибридный режим, попробуем запустить процесс
    const provider = process.env.AI_PROVIDER || 'ollama';
    if (provider === 'ollama' || provider === 'hybrid_ollama') {
      const model =
        provider === 'hybrid_ollama'
          ? 'gemma4:e4b-8k'
          : process.env.OLLAMA_MODEL || 'gemma4:e4b-8k';
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
      // Эмуляция печатания для провайдеров без стриминга
      for (const char of result.message) {
        yield char;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
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
   * Обработка содержимого документа с использованием паттерна ReAct
   */
  async processDocument(content: string): Promise<string> {
    const REACT_SYSTEM_PROMPT = `
Ты — продвинутый ИИ-ассистент по обработке документов, работающий по циклу ReAct.
Твоя задача — проанализировать содержимое файла и подготовить финальный результат для записи.

Доступные инструменты:
1. read_document_context[]: Возвращает текущее содержимое файла, который ты обрабатываешь.

Формат твоего ответа ДОЛЖЕН СТРОГО следовать шаблону:
Thought: [твои рассуждения о том, что нужно сделать с текстом]
Action: название_инструмента[]
(После Action ты должен остановиться и подождать Observation)

Когда ты полностью подготовил текст для записи в файл:
Final Answer: [здесь должен быть ТОЛЬКО итоговый текст документа без лишних пояснений]
`;

    let messages: { role: string; content: string }[] = [
      { role: 'system', content: REACT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Начни обработку документа. Используй read_document_context[] для получения текста.`
      }
    ];

    let finalResult = '';
    const maxIterations = 5;

    for (let i = 0; i < maxIterations; i++) {
      const response = await this.ai.simpleChat(
        'react-session-' + Date.now(),
        JSON.stringify(messages)
      );
      messages.push({ role: 'assistant', content: response });

      const thoughtMatch = response.match(/Thought:(.*)/);
      if (thoughtMatch) {
        console.log(`\n🤔 Рассуждение: ${thoughtMatch[1].trim()}`);
      }

      const actionMatch = response.match(/Action:\s*(\w+)\[(.*?)\]/);
      if (actionMatch) {
        const toolName = actionMatch[1];
        console.log(`🛠️ Действие: Вызываю ${toolName}`);

        let observation = '';
        if (toolName === 'read_document_context') {
          observation = content;
        } else {
          observation = `Ошибка: Инструмент ${toolName} не найден.`;
        }

        console.log(`👁️ Наблюдение получено (длина: ${observation.length} симв.)`);
        messages.push({ role: 'user', content: `Observation: ${observation}` });
        continue;
      }

      if (response.includes('Final Answer:')) {
        finalResult = response.split('Final Answer:').pop()?.trim() || '';
        break;
      }

      if (i === maxIterations - 1) {
        console.error('❌ Достигнут лимит итераций ReAct.');
      }
    }

    return finalResult || content;
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

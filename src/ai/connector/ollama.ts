import { AIHelperInterface, ToolCallRequest, ToolCallResult, ToolDescriptor } from './interface.js';
import { SessionStorage } from './session-storage.js';
import { Ollama, Message } from 'ollama';

interface Session {
  messages: Message[];
  toolResult: Record<string, any>;
}

export class OllamaHelper implements AIHelperInterface {
  protected session: SessionStorage<Session> = new SessionStorage<Session>(() => ({
    messages: this.systemPrompt
      ? [
          {
            role: 'system',
            content: this.systemPrompt
          }
        ]
      : [],
    toolResult: {}
  }));

  private client: Ollama;

  constructor(
    private readonly model: string,
    private readonly systemPrompt: string,
    host: string = 'http://localhost:11434'
  ) {
    this.client = new Ollama({ host });
  }

  async chatWithTools(
    sessionId: string,
    message: string,
    tools: ToolDescriptor[]
  ): Promise<ToolCallRequest> {
    const session = this.session.get(sessionId);

    const ollamaTools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as any
      }
    }));

    session.messages.push({
      role: 'user',
      content: message
    });

    const response = await this.client.chat({
      model: this.model,
      messages: session.messages,
      tools: ollamaTools as any
    });

    const messageResponse = response.message;
    session.messages.push(messageResponse);

    const toolCalls = messageResponse.tool_calls || [];

    return {
      message: messageResponse.content ?? '',
      toolCalls: toolCalls.map((tc) => ({
        id: Math.random().toString(36).substring(7), // Ollama не всегда возвращает ID для вызовов
        name: tc.function.name,
        arguments: tc.function.arguments
      }))
    };
  }

  async resetSession(sessionId: string): Promise<void> {
    this.session.reset(sessionId);
  }

  async simpleChat(sessionId: string, message: string): Promise<string> {
    const session = this.session.get(sessionId);
    session.messages.push({
      role: 'user',
      content: message
    });
    const response = await this.client.chat({
      model: this.model,
      messages: session.messages
    });

    const responseMessage = response.message;
    session.messages.push(responseMessage);

    return responseMessage.content ?? '';
  }

  async *chatStream(sessionId: string, message: string): AsyncGenerator<string> {
    const session = this.session.get(sessionId);
    session.messages.push({
      role: 'user',
      content: message
    });

    const response = await this.client.chat({
      model: this.model,
      messages: session.messages,
      stream: true
    });

    let fullContent = '';
    for await (const part of response) {
      const content = part.message.content ?? '';
      fullContent += content;
      yield content;
    }

    session.messages.push({
      role: 'assistant',
      content: fullContent
    });
  }

  async storeToolResult(sessionId: string, result: ToolCallResult): Promise<void> {
    this.session.get(sessionId).messages.push({
      role: 'tool',
      content: result.content
    } as any);

    if (result.request.id && result.structuredContent)
      this.session.get(sessionId).toolResult[result.request.id] = result.structuredContent;
  }
}

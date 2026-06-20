import { AIHelperInterface, ToolCallRequest, ToolCallResult, ToolDescriptor } from '../types.js';
import { Ollama, Message } from 'ollama';

interface Session {
  messages: Message[];
  toolResult: Record<string, any>;
  systemPrompt: string;
}

export class OllamaHelper implements AIHelperInterface {
  protected sessions: Record<string, Session> = {};

  private client: Ollama;

  constructor(
    private readonly model: string,
    private readonly systemPrompt: string,
    host: string = 'http://localhost:11434'
  ) {
    this.client = new Ollama({ host });
  }

  protected getSession(sessionId: string): Session {
    if (!this.sessions[sessionId]) {
      this.sessions[sessionId] = {
        messages: this.systemPrompt
          ? [
              {
                role: 'system',
                content: this.systemPrompt
              }
            ]
          : [],
        toolResult: {},
        systemPrompt: this.systemPrompt
      };
    }
    return this.sessions[sessionId];
  }

  private applySystemPrompt(session: Session, prompt: string): void {
    const normalizedPrompt = prompt.trim();
    const firstMessage = session.messages[0];
    const hasSystemMessage = firstMessage?.role === 'system';

    if (!normalizedPrompt) {
      if (hasSystemMessage) {
        session.messages.shift();
      }
      session.systemPrompt = '';
      return;
    }

    if (hasSystemMessage) {
      firstMessage.content = normalizedPrompt;
    } else {
      session.messages.unshift({
        role: 'system',
        content: normalizedPrompt
      });
    }

    session.systemPrompt = normalizedPrompt;
  }

  async setSessionSystemPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.getSession(sessionId);
    this.applySystemPrompt(session, prompt);
  }

  async chatWithTools(
    sessionId: string,
    message: string,
    tools: ToolDescriptor[],
    overrideModel?: string
  ): Promise<ToolCallRequest> {
    const session = this.getSession(sessionId);

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
      model: overrideModel || this.model,
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
    delete this.sessions[sessionId];
  }

  async simpleChat(sessionId: string, message: string, overrideModel?: string): Promise<string> {
    const session = this.getSession(sessionId);
    session.messages.push({
      role: 'user',
      content: message
    });
    const response = await this.client.chat({
      model: overrideModel || this.model,
      messages: session.messages
    });

    const responseMessage = response.message;
    session.messages.push(responseMessage);

    return responseMessage.content ?? '';
  }

  async *chatStream(
    sessionId: string,
    message: string,
    overrideModel?: string
  ): AsyncGenerator<string> {
    const session = this.getSession(sessionId);
    session.messages.push({
      role: 'user',
      content: message
    });

    const response = await this.client.chat({
      model: overrideModel || this.model,
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
    const session = this.getSession(sessionId);
    session.messages.push({
      role: 'tool',
      content: result.content
    } as any);

    if (result.request.id && result.structuredContent) {
      session.toolResult[result.request.id] = result.structuredContent;
    }
  }
}

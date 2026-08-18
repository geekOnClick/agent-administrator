import { AIHelperInterface, ToolCallRequest, ToolCallResult, ToolDescriptor } from '../types.js';
import { OllamaHelper } from '../providers/ollama.js';

/**
 * Обёртка над локальной моделью Ollama для задач EASY-режима (ask, askMeters, свободный
 * tool-calling чат). В отличие от прежнего OllamaRoutedHelper здесь НЕТ классификации
 * сложности сообщения — какую модель использовать для какой команды теперь решает
 * единый `ModelRouter` (см. model-router.ts) ДО вызова. Эта обёртка отвечает только
 * за фактическое обращение к Ollama и fallback на резервную модель при ошибке.
 */
export class OllamaFallbackHelper implements AIHelperInterface {
  private readonly failedSessions = new Set<string>();

  constructor(
    private readonly base: OllamaHelper,
    private readonly primaryModel: string,
    private readonly fallbackModel: string
  ) {}

  private modelFor(sessionId: string): string {
    return this.failedSessions.has(sessionId) ? this.fallbackModel : this.primaryModel;
  }

  private async runWithFallback<T>(
    sessionId: string,
    targetModel: string,
    fallbackLabel: string,
    action: (model: string) => Promise<T>,
    fallbackAction: () => Promise<T>
  ): Promise<T> {
    try {
      return await action(targetModel);
    } catch (error) {
      console.error(
        `[${fallbackLabel}] Error on ${targetModel}: ${error}. Switch to ${this.fallbackModel}`
      );
      this.failedSessions.add(sessionId);
      return await fallbackAction();
    }
  }

  async chatWithTools(
    sessionId: string,
    message: string,
    tools: ToolDescriptor[]
  ): Promise<ToolCallRequest> {
    const targetModel = this.modelFor(sessionId);

    return this.runWithFallback(
      sessionId,
      targetModel,
      'Fallback Tools',
      (model) => this.base.chatWithTools(sessionId, message, tools, model),
      async () => {
        const fallbackResponse = await this.base.simpleChat(sessionId, message, this.fallbackModel);
        return { message: fallbackResponse, toolCalls: [] };
      }
    );
  }

  async storeToolResult(sessionId: string, result: ToolCallResult): Promise<void> {
    await this.base.storeToolResult(sessionId, result);
  }

  async setSessionSystemPrompt(sessionId: string, prompt: string): Promise<void> {
    await this.base.setSessionSystemPrompt(sessionId, prompt);
  }

  async simpleChat(sessionId: string, message: string): Promise<string> {
    const targetModel = this.modelFor(sessionId);

    return this.runWithFallback(
      sessionId,
      targetModel,
      'Fallback',
      (model) => this.base.simpleChat(sessionId, message, model),
      () => this.base.simpleChat(sessionId, message, this.fallbackModel)
    );
  }

  async resetSession(sessionId: string): Promise<void> {
    this.failedSessions.delete(sessionId);
    await this.base.resetSession(sessionId);
  }

  async *chatStream(sessionId: string, message: string): AsyncIterable<string> {
    const targetModel = this.modelFor(sessionId);

    try {
      yield* this.base.chatStream(sessionId, message, targetModel);
    } catch (error) {
      console.error(
        `[Fallback Stream] Error on ${targetModel}: ${error}. Switch to ${this.fallbackModel}`
      );
      this.failedSessions.add(sessionId);
      const fallbackResponse = await this.base.simpleChat(sessionId, message, this.fallbackModel);
      yield fallbackResponse;
    }
  }
}

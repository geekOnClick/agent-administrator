import { AIHelperInterface, ToolCallRequest, ToolCallResult, ToolDescriptor } from '../types.js';
import { OllamaHelper } from '../providers/ollama.js';
import { QueryComplexityRouter } from './query-complexity-router.js';

export class OllamaRoutedHelper implements AIHelperInterface {
  private readonly selectedModelBySession: Record<string, string> = {};

  constructor(
    private readonly base: OllamaHelper,
    private readonly router: QueryComplexityRouter,
    private readonly cheapModel: string,
    private readonly expertModel: string,
    private readonly fallbackModel: string
  ) {}

  private async selectModelForUserTurn(sessionId: string, message: string): Promise<string> {
    const complexity = await this.router.evaluateComplexity(message);
    const targetModel = complexity === 'HARD' ? this.expertModel : this.cheapModel;
    this.selectedModelBySession[sessionId] = targetModel;

    console.error(`Mode ${complexity}. Selected model - ${targetModel}`);
    return targetModel;
  }

  private async resolveModel(sessionId: string, message: string): Promise<string> {
    return (
      this.selectedModelBySession[sessionId] ||
      (await this.selectModelForUserTurn(sessionId, message))
    );
  }

  private clearSelectedModel(sessionId: string): void {
    delete this.selectedModelBySession[sessionId];
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
      this.selectedModelBySession[sessionId] = this.fallbackModel;
      return await fallbackAction();
    }
  }

  async chatWithTools(
    sessionId: string,
    message: string,
    tools: ToolDescriptor[]
  ): Promise<ToolCallRequest> {
    const targetModel = await this.selectModelForUserTurn(sessionId, message);

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
    const targetModel = await this.resolveModel(sessionId, message);

    return this.runWithFallback(
      sessionId,
      targetModel,
      'Fallback',
      (model) => this.base.simpleChat(sessionId, message, model),
      () => this.base.simpleChat(sessionId, message, this.fallbackModel)
    );
  }

  async resetSession(sessionId: string): Promise<void> {
    this.clearSelectedModel(sessionId);
    await this.base.resetSession(sessionId);
  }

  async *chatStream(sessionId: string, message: string): AsyncIterable<string> {
    const targetModel = await this.selectModelForUserTurn(sessionId, message);

    try {
      yield* this.base.chatStream(sessionId, message, targetModel);
    } catch (error) {
      console.error(
        `[Fallback Stream] Error on ${targetModel}: ${error}. Switch to ${this.fallbackModel}`
      );
      this.selectedModelBySession[sessionId] = this.fallbackModel;
      const fallbackResponse = await this.base.simpleChat(sessionId, message, this.fallbackModel);
      yield fallbackResponse;
    }
  }
}

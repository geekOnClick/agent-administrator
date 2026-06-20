import { AIHelperInterface, ToolCallRequest, ToolCallResult, ToolDescriptor } from '../types.js';
import { OllamaHelper } from '../providers/ollama.js';
import { QueryComplexityRouter } from './query-complexity-router.js';

export class OllamaRoutedHelper implements AIHelperInterface {
  constructor(
    private readonly base: OllamaHelper,
    private readonly router: QueryComplexityRouter,
    private readonly cheapModel: string,
    private readonly expertModel: string,
    private readonly fallbackModel: string
  ) {}

  async chatWithTools(
    sessionId: string,
    message: string,
    tools: ToolDescriptor[]
  ): Promise<ToolCallRequest> {
    const complexity = await this.router.evaluateComplexity(message);
    const targetModel = complexity === 'HARD' ? this.expertModel : this.cheapModel;

    console.error(`Mode ${complexity}. Selected model - ${targetModel}`);

    try {
      return await this.base.chatWithTools(sessionId, message, tools, targetModel);
    } catch (error) {
      console.error(
        `[Fallback Tools] Error on ${targetModel}: ${error}. Switch to ${this.fallbackModel}`
      );
      const fallbackResponse = await this.base.simpleChat(sessionId, message, this.fallbackModel);
      return { message: fallbackResponse, toolCalls: [] };
    }
  }

  async storeToolResult(sessionId: string, result: ToolCallResult): Promise<void> {
    await this.base.storeToolResult(sessionId, result);
  }

  async setSessionSystemPrompt(sessionId: string, prompt: string): Promise<void> {
    await this.base.setSessionSystemPrompt(sessionId, prompt);
  }

  async simpleChat(sessionId: string, message: string): Promise<string> {
    const complexity = await this.router.evaluateComplexity(message);
    const targetModel = complexity === 'HARD' ? this.expertModel : this.cheapModel;

    console.error(`Mode ${complexity}. Selected model - ${targetModel}`);

    try {
      return await this.base.simpleChat(sessionId, message, targetModel);
    } catch (error) {
      console.error(
        `[Fallback] Error on ${targetModel}: ${error}. Switch to ${this.fallbackModel}`
      );
      return await this.base.simpleChat(sessionId, message, this.fallbackModel);
    }
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.base.resetSession(sessionId);
  }

  async *chatStream(sessionId: string, message: string): AsyncIterable<string> {
    const complexity = await this.router.evaluateComplexity(message);
    const targetModel = complexity === 'HARD' ? this.expertModel : this.cheapModel;

    console.error(`Mode ${complexity}. Selected model - ${targetModel}`);

    try {
      yield* this.base.chatStream(sessionId, message, targetModel);
    } catch (error) {
      console.error(
        `[Fallback Stream] Error on ${targetModel}: ${error}. Switch to ${this.fallbackModel}`
      );
      const fallbackResponse = await this.base.simpleChat(sessionId, message, this.fallbackModel);
      yield fallbackResponse;
    }
  }
}

import { OllamaHelper } from '../providers/ollama.js';

export type QueryComplexity = 'EASY' | 'HARD';

export class QueryComplexityRouter {
  constructor(
    private readonly classifier: OllamaHelper,
    private readonly routerModel: string,
    private readonly systemPrompt: string
  ) {}

  async evaluateComplexity(userQuery: string): Promise<QueryComplexity> {
    const routerSessionId = 'router-temp-session';

    try {
      await this.classifier.setSessionSystemPrompt(routerSessionId, this.systemPrompt);
      const response = await this.classifier.simpleChat(
        routerSessionId,
        userQuery,
        this.routerModel
      );
      await this.classifier.resetSession(routerSessionId);

      return response.toUpperCase().includes('HARD') ? 'HARD' : 'EASY';
    } catch (error) {
      console.error(`[Router] Error: ${error}. Use HARD by default.`);
      return 'HARD';
    }
  }
}

import { OllamaHelper } from '../providers/ollama.js';

export type QueryComplexity = 'EASY' | 'HARD';

export class QueryComplexityRouter {
  constructor(private readonly classifier: OllamaHelper, private readonly routerModel: string) {}

  async evaluateComplexity(userQuery: string): Promise<QueryComplexity> {
    const systemPrompt = `Ты — когнитивный роутер. Твоя задача — классифицировать запрос пользователя.
Отвечай СТРОГО одним словом: EASY или HARD.
EASY: простые вопросы, форматирование текста, базовый код, общие знания.
HARD: сложная архитектура, глубокие рассуждения, математика, многошаговые задачи.
Запрос: `;

    try {
      const response = await this.classifier.simpleChat(
        'router-temp-session',
        `${systemPrompt}\n${userQuery}`,
        this.routerModel
      );
      await this.classifier.resetSession('router-temp-session');

      return response.toUpperCase().includes('HARD') ? 'HARD' : 'EASY';
    } catch (error) {
      console.error(`[Router] Error: ${error}. Use HARD by default.`);
      return 'HARD';
    }
  }
}

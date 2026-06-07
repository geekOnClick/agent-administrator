import { OllamaHelper } from './ollama.js';
import { ToolDescriptor, ToolCallRequest } from './interface.js';

export class HybridOllamaHelper extends OllamaHelper {
  private readonly ROUTER_MODEL = 'gemma4:e4b-8k';
  private readonly CHEAP_MODEL = 'gemma4:e4b-8k';
  private readonly EXPERT_MODEL = 'gemma4:12b';
  private readonly FALLBACK_MODEL = 'gemma4:e4b-8k';

  private async evaluateComplexity(userQuery: string): Promise<'EASY' | 'HARD'> {
    const systemPrompt = `Ты — когнитивный роутер. Твоя задача — классифицировать запрос пользователя.
Отвечай СТРОГО одним словом: EASY или HARD.
EASY: простые вопросы, форматирование текста, базовый код, общие знания.
HARD: сложная архитектура, глубокие рассуждения, математика, многошаговые задачи.
Запрос: `;

    try {
      // Используем временную сессию для роутинга, чтобы не засорять основную историю
      const response = await super.simpleChat(
        'router-temp-session',
        `${systemPrompt}\n${userQuery}`,
        this.ROUTER_MODEL
      );
      await super.resetSession('router-temp-session');

      return response.toUpperCase().includes('HARD') ? 'HARD' : 'EASY';
    } catch (error) {
      console.error(`[Роутер] Ошибка: ${error}. Используем HARD по умолчанию.`);
      return 'HARD';
    }
  }

  override async simpleChat(sessionId: string, message: string): Promise<string> {
    const complexity = await this.evaluateComplexity(message);
    const targetModel = complexity === 'HARD' ? this.EXPERT_MODEL : this.CHEAP_MODEL;

    console.error(`Режим ${complexity}. Выбрана модель - ${targetModel}`);

    try {
      return await super.simpleChat(sessionId, message, targetModel);
    } catch (error) {
      console.error(
        `[Fallback] Ошибка основной модели (${targetModel}): ${error}. Переключение на ${this.FALLBACK_MODEL}`
      );
      return await super.simpleChat(sessionId, message, this.FALLBACK_MODEL);
    }
  }

  override async chatWithTools(
    sessionId: string,
    message: string,
    tools: ToolDescriptor[]
  ): Promise<ToolCallRequest> {
    const complexity = await this.evaluateComplexity(message);
    const targetModel = complexity === 'HARD' ? this.EXPERT_MODEL : this.CHEAP_MODEL;

    console.error(`Режим ${complexity}. Выбрана модель - ${targetModel}`);

    try {
      // Используем выбранную модель для вызова инструментов
      // Мы вызываем приватный метод через приведение к any, так как OllamaHelper не предоставляет
      // возможности смены модели для chatWithTools без изменения состояния
      const session = (this as any).session.get(sessionId);
      const ollamaTools = tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema as any
        }
      }));

      session.messages.push({ role: 'user', content: message });

      const response = await (this as any).client.chat({
        model: targetModel,
        messages: session.messages,
        tools: ollamaTools as any
      });

      const messageResponse = response.message;
      session.messages.push(messageResponse);

      return {
        message: messageResponse.content ?? '',
        toolCalls: (messageResponse.tool_calls || []).map((tc: any) => ({
          id: Math.random().toString(36).substring(7),
          name: tc.function.name,
          arguments: tc.function.arguments
        }))
      };
    } catch (error) {
      console.error(
        `[Fallback Tools] Ошибка модели ${targetModel}: ${error}. Переключение на ${this.FALLBACK_MODEL}`
      );
      const fallbackResponse = await super.simpleChat(sessionId, message, this.FALLBACK_MODEL);
      return { message: fallbackResponse, toolCalls: [] };
    }
  }

  override async *chatStream(sessionId: string, message: string): AsyncGenerator<string> {
    const complexity = await this.evaluateComplexity(message);
    const targetModel = complexity === 'HARD' ? this.EXPERT_MODEL : this.CHEAP_MODEL;

    console.error(`Режим ${complexity}. Выбрана модель - ${targetModel}`);

    try {
      const session = (this as any).session.get(sessionId);
      session.messages.push({
        role: 'user',
        content: message
      });

      const response = await (this as any).client.chat({
        model: targetModel,
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
    } catch (error) {
      console.error(
        `[Fallback Stream] Ошибка модели ${targetModel}: ${error}. Переключение на ${this.FALLBACK_MODEL}`
      );
      const fallbackResponse = await super.simpleChat(sessionId, message, this.FALLBACK_MODEL);
      yield fallbackResponse;
    }
  }
}

import { AIHelperInterface } from './types.js';

import { OllamaHelper } from './providers/ollama.js';
import { OllamaFallbackHelper } from './routing/ollama-fallback-helper.js';
import { ASK_SYSTEM_PROMPT } from './prompts/profiles.js';

export enum AIProvider {
  OLLAMA = 'ollama'
}

/**
 * Создаёт локальный EASY-провайдер (Ollama) для режимов ask/askMeters/свободного чата.
 * выбор между EASY (локальная модель) и HARD (RouterAI) теперь принимает
 * единый `agentModelRouter` (см. routing/model-router.ts) НА уровне ChatProcessor/сервисов документов,
 * а не внутри этого провайдера.
 */
export class AIHelperProvider {
  static getAiProvider(type: AIProvider): AIHelperInterface {
    if (type !== AIProvider.OLLAMA) {
      throw new Error(`AI provider ${type} not supported`);
    }

    const host = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const baseModel = process.env.OLLAMA_MODEL || 'gemma4:e4b-8k';
    const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || baseModel;

    const base = new OllamaHelper(baseModel, ASK_SYSTEM_PROMPT, host);

    return new OllamaFallbackHelper(base, baseModel, fallbackModel);
  }
}

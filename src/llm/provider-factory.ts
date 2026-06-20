import { AIHelperInterface } from './types.js';

import { OllamaHelper } from './providers/ollama.js';
import { QueryComplexityRouter } from './routing/query-complexity-router.js';
import { OllamaRoutedHelper } from './routing/ollama-routed-helper.js';
import { ROUTER_SYSTEM_PROMPT, TALK_SYSTEM_PROMPT } from './prompts/profiles.js';

export enum AIProvider {
  OLLAMA = 'ollama'
}

export class AIHelperProvider {
  static getAiProvider(type: AIProvider): AIHelperInterface {
    if (type !== AIProvider.OLLAMA) {
      throw new Error(`AI provider ${type} not supported`);
    }

    const host = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const baseModel = process.env.OLLAMA_MODEL || 'gemma4:e4b-8k';
    const routerModel = process.env.OLLAMA_ROUTER_MODEL || baseModel;
    const cheapModel = process.env.OLLAMA_CHEAP_MODEL || baseModel;
    const expertModel = process.env.OLLAMA_EXPERT_MODEL || baseModel;
    const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || baseModel;

    const base = new OllamaHelper(baseModel, TALK_SYSTEM_PROMPT, host);
    const routerClassifier = new OllamaHelper(routerModel, ROUTER_SYSTEM_PROMPT, host);
    const router = new QueryComplexityRouter(routerClassifier, routerModel, ROUTER_SYSTEM_PROMPT);

    return new OllamaRoutedHelper(base, router, cheapModel, expertModel, fallbackModel);
  }
}

import { AIHelperInterface } from './interface.js';

import { OllamaHelper } from './ollama.js';

const systemPrompt = '';

export enum AIProvider {
  OLLAMA = 'ollama'
}

export class AIHelperProvider {
  static getAiProvider(type: AIProvider): AIHelperInterface {
    switch (type) {
      case AIProvider.OLLAMA:
        return new OllamaHelper(
          process.env.OLLAMA_MODEL || 'gemma4:e4b-8k',
          systemPrompt,
          process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
        );
    }
    throw new Error(`AI provider ${type} not supported`);
  }
}

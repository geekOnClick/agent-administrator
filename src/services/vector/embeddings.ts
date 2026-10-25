import { routerAIService } from '../RouterAIService.js';

/**
 * Эмбеддинги для векторизации данных таблицы учёта коммунальных платежей
 * (узлы :BillRow) и показаний счётчиков (:MeterRow) в FalkorDB.
 *
 * Раньше использовалась локальная Ollama-модель nomic-embed-text; теперь —
 * embeddings-endpoint RouterAI (модель ROUTERAI_EMBED_MODEL, по умолчанию
 * qwen/qwen3-embedding-4b). Размерность берётся динамически из ответа,
 * индекс FalkorDB пересоздаётся при каждом sync — смена embedding-модели безопасна.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  return routerAIService.embed(texts);
}

export async function embedOne(text: string): Promise<number[]> {
  return routerAIService.embedOne(text);
}
import { Ollama } from 'ollama';

/**
 * Клиент эмбеддингов для векторизации данных таблицы учёта коммунальных
 * платежей. По умолчанию использует локальную Ollama-модель nomic-embed-text
 * (совпадает с образцом falkordb-vector-agent).
 */
const OLLAMA_HOST = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

const ollama = new Ollama({ host: OLLAMA_HOST });

export async function embed(texts: string[]): Promise<number[][]> {
  const res = await ollama.embed({ model: EMBED_MODEL, input: texts });
  return res.embeddings;
}

export async function embedOne(text: string): Promise<number[]> {
  const [vec] = await embed([text]);
  return vec;
}

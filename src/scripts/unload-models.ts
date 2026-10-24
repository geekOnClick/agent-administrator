import 'dotenv/config';
import { OllamaHelper } from '../llm/ollama-helper.js';
import { config } from '../config.js';

/**
 * Служебный скрипт (npm run model:down): выгружает из памяти все загруженные
 * модели Ollama — та же логика, что при завершении агента (ChatProcessor.cleanup
 * → OllamaHelper.unloadAllModels, аналог цикла `ollama ps` + `ollama stop`).
 * Полезен, если агент завершился аварийно и модели остались висеть в памяти.
 */
async function main(): Promise<void> {
  const ollama = new OllamaHelper(config.ollama.model, '', config.ollama.host);
  await ollama.unloadAllModels();
  console.log('Все загруженные модели Ollama выгружены из памяти.');
}

main().catch((err) => {
  console.error(`Не удалось выгрузить модели Ollama: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

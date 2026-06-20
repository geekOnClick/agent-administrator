import { AiEntryPointInterface } from './types.js';
import { CliEntryPoint } from './clients/cli.js';
import { TelegramEntryPoint } from './clients/telegram.js';
import { ChatProcessor } from '../llm/chat-processor.js';

export async function selectEntrypoint(): Promise<AiEntryPointInterface> {
  const args = process.argv.slice(2);
  const processor = new ChatProcessor();
  if (args.includes('--cli')) {
    return new CliEntryPoint(processor);
  } else if (args.includes('--telegram')) {
    return new TelegramEntryPoint(processor);
  } else {
    throw new Error('Usage: node dist/index.js --cli | --telegram');
  }
}

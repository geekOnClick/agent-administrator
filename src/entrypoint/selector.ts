import { AiEntryPointInterface } from './interface.js';
import { CliEntryPoint } from './cli.js';
import { TelegramEntryPoint } from './telegram.js';
import { ChatProcessor } from '../ai/chat-processor.js';

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

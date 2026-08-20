import { AiEntryPointInterface } from './types.js';
import { CliEntryPoint } from './clients/cli.js';
import { TelegramEntryPoint } from './clients/telegram.js';
import { ChatProcessor } from '../llm/chat-processor.js';

export function selectEntrypoint(args: string[]): AiEntryPointInterface {
  if (args.includes('--telegram')) {
    return new TelegramEntryPoint();
  }
  if (args.includes('--cli')) {
    return new CliEntryPoint(new ChatProcessor());
  }
  throw new Error('Usage: tsx src/index.ts --cli|--telegram');
}

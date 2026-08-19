import { AiEntryPointInterface } from './types.js';
import { CliEntryPoint } from './clients/cli.js';
import { ChatProcessor } from '../llm/chat-processor.js';

export function selectEntrypoint(args: string[]): AiEntryPointInterface {
  if (!args.includes('--cli')) {
    throw new Error('Usage: tsx src/index.ts --cli');
  }
  return new CliEntryPoint(new ChatProcessor());
}

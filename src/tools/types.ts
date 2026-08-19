import { z } from 'zod';

/**
 * Контракт инструмента агента (function calling внутри процесса, без MCP):
 * имя, описание для LLM/документации, Zod-схема аргументов и обработчик,
 * принимающий уже провалидированные схемой аргументы.
 */
export interface AgentTool<S extends z.ZodType, R> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: S;
  execute(args: z.output<S>): Promise<R>;
}

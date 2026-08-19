import { downloadBillsTool, DownloadBillsInput, DownloadBillsResult } from './download-bills.tool.js';
import { organizeBillsTool, OrganizeBillsInput, OrganizeBillsResult } from './organize-bills.tool.js';
import { checkBillReceiptsTool, CheckBillReceiptsInput } from './check-receipts.tool.js';
import { generateSordisuBillTool, GenerateSordisuBillInput, GenerateSordisuBillResult } from './generate-sordisu-bill.tool.js';
import type { ReceiptsCheckResult } from '../services/ReceiptVerificationService.js';

// Реестр инструментов агента (function calling внутри процесса).
export const toolRegistry = {
  [downloadBillsTool.name]: downloadBillsTool,
  [organizeBillsTool.name]: organizeBillsTool,
  [checkBillReceiptsTool.name]: checkBillReceiptsTool,
  [generateSordisuBillTool.name]: generateSordisuBillTool
} as const;

export type ToolName = keyof typeof toolRegistry;

/**
 * Единая точка вызова инструментов агента. Аргументы каждого инструмента
 * валидируются его Zod-схемой (несоответствие — ZodError до входа в обработчик).
 * Сигнатуры перегружены, поэтому тип результата выводится из имени инструмента.
 */
export async function callTool(
  name: 'download_bills_from_yandex',
  args: DownloadBillsInput
): Promise<DownloadBillsResult>;
export async function callTool(name: 'organize_bills', args: OrganizeBillsInput): Promise<OrganizeBillsResult>;
export async function callTool(
  name: 'check_bill_receipts',
  args: CheckBillReceiptsInput
): Promise<ReceiptsCheckResult>;
export async function callTool(
  name: 'generate_sordisu_bill',
  args: GenerateSordisuBillInput
): Promise<GenerateSordisuBillResult>;
export async function callTool(name: ToolName, args: unknown): Promise<unknown> {
  const tool = toolRegistry[name];
  const parsed = tool.schema.parse(args);
  return tool.execute(parsed as never);
}

import { z } from 'zod';
import {
  receiptVerificationService,
  ReceiptsCheckResult
} from '../services/ReceiptVerificationService.js';
import type { AgentTool } from './types.js';

export const checkBillReceiptsSchema = z.object({
  monthDir: z
    .string()
    .optional()
    .describe('Путь к папке месяца со счетами (по умолчанию папка текущего месяца)')
});

export type CheckBillReceiptsInput = z.output<typeof checkBillReceiptsSchema>;

export const checkBillReceiptsTool: AgentTool<typeof checkBillReceiptsSchema, ReceiptsCheckResult> = {
  name: 'check_bill_receipts',
  title: 'Проверить квитанции об оплате счетов',
  description:
    'Проверяет, что в каждой папке (куда organize_bills разложил счета) фактически присутствует квитанция/чек об оплате ' +
    '(суммы не сравниваются). Посторонние документы (УПД, акты и т.п.) игнорируются. Для текстовых документов ' +
    'тип определяется детерминированно по платёжным маркерам; сканы/фото и неоднозначные случаи анализируются ' +
    'облачной моделью RouterAI (с fallback на резервную модель при недоступности основной).',
  schema: checkBillReceiptsSchema,

  async execute({ monthDir }): Promise<ReceiptsCheckResult> {
    return monthDir
      ? receiptVerificationService.checkAllFolders(monthDir)
      : receiptVerificationService.checkAllFolders();
  }
};

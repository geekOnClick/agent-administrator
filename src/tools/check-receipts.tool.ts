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
    '(суммы не сравниваются). Посторонние документы (УПД, акты и т.п.) игнорируются. Для каждого файла-кандидата ' +
    'встроенный роутер выбирает модель: EASY — локальная Ollama (gemma), HARD — RouterAI (сканы/изображения или ' +
    'сложные случаи). Выбранная для каждого файла модель логируется в консоль.',
  schema: checkBillReceiptsSchema,

  async execute({ monthDir }): Promise<ReceiptsCheckResult> {
    return monthDir
      ? receiptVerificationService.checkAllFolders(monthDir)
      : receiptVerificationService.checkAllFolders();
  }
};

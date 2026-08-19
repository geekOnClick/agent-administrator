import { z } from 'zod';
import { sordisuBillGeneratorService } from '../services/SordisuBillGeneratorService.js';
import { getCurrentMonthDir as getCurrentOrganizeBillsMonthDir } from './organize-bills.tool.js';
import type { AgentTool } from './types.js';

const BILL_CATEGORIES = ['electricity', 'heat', 'water', 'garbage', 'maintenance'] as const;

export const generateSordisuBillSchema = z.object({
  excludeCategories: z
    .array(z.enum(BILL_CATEGORIES))
    .optional()
    .describe(
      'Категории, которые нужно исключить из итогового счёта (найденые чека в которых не подтверждены, но принудительно продолжен цикл командой continue!).'
    )
});

export type GenerateSordisuBillInput = z.output<typeof generateSordisuBillSchema>;

export interface GenerateSordisuBillResult {
  monthDir: string;
  copiedFiles: string[];
  pdfPath: string;
  spravkaPdfPath: string;
  spravkaTotalWithVat: number;
  spravkaCategoriesFilled: string[];
  spravkaWarnings: string[];
  kommunalkaPdfPath: string;
  copiedOrganizedDocsCount: number;
  excludedCategories: string[];
}

export const generateSordisuBillTool: AgentTool<typeof generateSordisuBillSchema, GenerateSordisuBillResult> = {
  name: 'generate_sordisu_bill',
  title: 'Сгенерировать счёт аренды "Сордису" за текущий месяц',
  description:
    'Создаёт папку текущего месяца (на русском, со строчной буквы) в "Сордису по месяцам", ' +
    'копирует туда все файлы из папки-шаблона, затем заполняет актуальные даты в файле "счет.doc" ' +
    '(дата счёта и месяц аренды), данные в файле "справка-расчет.docx" (дата справки, месяц оказания услуг ' +
    'и столбцы таблицы — на основе данных из счетов текущего месяца, проанализированных RouterAI) ' +
    'и данные в файле "счет коммуналка.docx" (дата счёта, месяц оказания услуг и итоговая сумма/расшифровка, ' +
    'взятые из уже рассчитанной справки-расчёта), сохраняет все результаты в pdf и удаляет исходные .doc/.docx.',
  schema: generateSordisuBillSchema,

  async execute({ excludeCategories }): Promise<GenerateSordisuBillResult> {
    const excluded = excludeCategories ?? [];
    const excludeSpravkaCategories = excluded.filter(
      (c): c is 'electricity' | 'heat' | 'water' | 'garbage' => c !== 'maintenance'
    );
    const { monthDir, copiedFiles } = sordisuBillGeneratorService.createMonthFolderFromTemplate();
    const { pdfPath } = await sordisuBillGeneratorService.fillAndConvertBillDoc(monthDir);
    const spravkaResult = await sordisuBillGeneratorService.fillAndConvertSpravkaDoc(
      monthDir,
      excludeSpravkaCategories
    );
    const kommunalkaResult = await sordisuBillGeneratorService.fillAndConvertKommunalkaDoc(
      monthDir,
      spravkaResult.totalWithVat
    );

    const orgMonthDir = getCurrentOrganizeBillsMonthDir();
    const { copiedFiles: copiedOrganizedDocs } = sordisuBillGeneratorService.copyOrganizedDocsToMonthFolder(
      monthDir,
      orgMonthDir,
      excluded
    );

    return {
      monthDir,
      copiedFiles,
      pdfPath,
      spravkaPdfPath: spravkaResult.pdfPath,
      spravkaTotalWithVat: spravkaResult.totalWithVat,
      spravkaCategoriesFilled: spravkaResult.categoriesFilled,
      spravkaWarnings: spravkaResult.warnings,
      kommunalkaPdfPath: kommunalkaResult.pdfPath,
      copiedOrganizedDocsCount: copiedOrganizedDocs.length,
      excludedCategories: excluded
    };
  }
};

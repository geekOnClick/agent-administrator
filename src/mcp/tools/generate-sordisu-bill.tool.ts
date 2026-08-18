import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sordisuBillGeneratorService } from '../../services/SordisuBillGeneratorService.js';
import { getCurrentMonthDir as getCurrentOrganizeBillsMonthDir } from './organize-bills.tool.js';

export const generateSordisuBillInputSchema = {
  excludeCategories: z
    .array(z.enum(['electricity', 'heat', 'water', 'garbage', 'maintenance']))
    .optional()
    .describe(
      'Категории, которые нужно исключить из итогового счёта (найденые чека в которых не подтверждены, но принудительно продолжен цикл командой continue!).'
    )
};

export function registerGenerateSordisuBillTool(server: McpServer): void {
  server.registerTool(
    'generate_sordisu_bill',
    {
      title: 'Сгенерировать счёт аренды "Сордису" за текущий месяц',
      description:
        'Создаёт папку текущего месяца (на русском, со строчной буквы) в "Сордису по месяцам", ' +
        'копирует туда все файлы из папки-шаблона, затем заполняет актуальные даты в файле "счет.doc" ' +
        '(дата счёта и месяц аренды), данные в файле "справка-расчет.docx" (дата справки, месяц оказания услуг ' +
        'и столбцы таблицы — на основе данных из счетов текущего месяца, проанализированных RouterAI) ' +
        'и данные в файле "счет коммуналка.docx" (дата счёта, месяц оказания услуг и итоговая сумма/расшифровка, ' +
        'взятые из уже рассчитанной справки-расчёта), сохраняет все результаты в pdf и удаляет исходные .doc/.docx.',
      inputSchema: generateSordisuBillInputSchema
    },
    async (req) => {
      try {
        const excludeCategories = req.excludeCategories ?? [];
        const excludeSpravkaCategories = excludeCategories.filter(
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
          excludeCategories
        );

        const warningsText =
          spravkaResult.warnings.length > 0
            ? `\nПредупреждения по справке-расчёту:\n` + spravkaResult.warnings.map((w) => `  - ${w}`).join('\n')
            : '';

        return {
          content: [
            {
              type: 'text',
              text:
                `Счёт "Сордису" сгенерирован.\n` +
                `Папка месяца: ${monthDir}\n` +
                `Скопировано файлов из шаблона: ${copiedFiles.length}\n` +
                `PDF счёта: ${pdfPath}\n` +
                `PDF справки-расчёта: ${spravkaResult.pdfPath}\n` +
                `Итоговая сумма справки-расчёта: ${spravkaResult.totalWithVat.toFixed(2)} руб.\n` +
                `PDF счёта-коммуналки: ${kommunalkaResult.pdfPath}\n` +
                `Скопировано счетов/квитанций из "${orgMonthDir}": ${copiedOrganizedDocs.length}` +
                (excludeCategories.length > 0
                  ? `\n⚠️ Исключены из итогового счёта (нет квитанции): ${excludeCategories.join(', ')}`
                  : '') +
                warningsText
            }
          ],
          structuredContent: {
            monthDir,
            copiedFiles,
            pdfPath,
            spravkaPdfPath: spravkaResult.pdfPath,
            spravkaTotalWithVat: spravkaResult.totalWithVat,
            spravkaCategoriesFilled: spravkaResult.categoriesFilled,
            spravkaWarnings: spravkaResult.warnings,
            kommunalkaPdfPath: kommunalkaResult.pdfPath,
            copiedOrganizedDocsCount: copiedOrganizedDocs.length,
            excludedCategories: excludeCategories
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Ошибка генерации счёта "Сордису": ${String(error)}` }]
        };
      }
    }
  );
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sordisuBillGeneratorService } from '../../services/SordisuBillGeneratorService.js';
import { getCurrentMonthDir as getCurrentOrganizeBillsMonthDir } from './organize-bills.tool.js';

export const generateSordisuBillInputSchema = {};

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
    async () => {
      try {
        const { monthDir, copiedFiles } = sordisuBillGeneratorService.createMonthFolderFromTemplate();
        const { pdfPath } = await sordisuBillGeneratorService.fillAndConvertBillDoc(monthDir);
        const spravkaResult = await sordisuBillGeneratorService.fillAndConvertSpravkaDoc(monthDir);
        const kommunalkaResult = await sordisuBillGeneratorService.fillAndConvertKommunalkaDoc(
          monthDir,
          spravkaResult.totalWithVat
        );

        const orgMonthDir = getCurrentOrganizeBillsMonthDir();
        const { copiedFiles: copiedOrganizedDocs } = sordisuBillGeneratorService.copyOrganizedDocsToMonthFolder(
          monthDir,
          orgMonthDir
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
            copiedOrganizedDocsCount: copiedOrganizedDocs.length
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

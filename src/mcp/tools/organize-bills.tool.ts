import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

// Base directory for storing documents by month
const BASE_DIR = '/home/geekonclick/Рабочий стол/Администрирование2026/Документы по месяцам';

// Month names in Russian with capital first letter
const MONTH_NAMES_RU: Record<number, string> = {
  0: 'Январь',
  1: 'Февраль',
  2: 'Март',
  3: 'Апрель',
  4: 'Май',
  5: 'Июнь',
  6: 'Июль',
  7: 'Август',
  8: 'Сентябрь',
  9: 'Октябрь',
  10: 'Ноябрь',
  11: 'Декабрь'
};

// Categories that require an intermediate 1292 subfolder (as in the July example)
const CATEGORIES_WITH_1292 = new Set(['electricity', 'heat']);

// Category -> folder name mapping (matching the July example structure)
const CATEGORY_DIR_NAMES: Record<string, string> = {
  electricity: 'электро',
  heat: 'тепло',
  water: 'Водоканал',
  garbage: 'Нижэкология',
  maintenance: 'Наш дом'
};

export const organizeBillsInputSchema = {
  bills: z
    .array(
      z.object({
        filePath: z.string().describe('Абсолютный путь к файлу счета'),
        category: z
          .enum(['electricity', 'heat', 'water', 'garbage', 'maintenance'])
          .describe('Категория коммунальной услуги')
      })
    )
    .describe('Массив счетов с их категориями')
};

export function registerOrganizeBillsTool(server: McpServer): void {
  server.registerTool(
    'organize_bills',
    {
      title: 'Разложить счета по папкам',
      description:
        'Создаёт директорию текущего месяца (на русском) в /home/geekonclick/Рабочий стол/Администрирование2026/Документы по месяцам, ' +
        'подпапки по категориям услуг и копирует туда файлы счетов. ' +
        'Для электричества (electricity) и теплоэнергии (heat) создаётся промежуточная папка 1292.',
      inputSchema: organizeBillsInputSchema
    },
    async (req) => {
      try {
        const now = new Date();
        const monthName = MONTH_NAMES_RU[now.getMonth()];
        const monthDir = path.join(BASE_DIR, monthName);

        const placed: string[] = [];

        for (const bill of req.bills) {
          const catDirName = CATEGORY_DIR_NAMES[bill.category];
          if (!catDirName) {
            continue;
          }

          let targetDir: string;
          if (CATEGORIES_WITH_1292.has(bill.category)) {
            // electricity, heat: <месяц>/1292/<услуга>/
            targetDir = path.join(monthDir, '1292', catDirName);
          } else {
            // water, garbage, maintenance: <месяц>/<услуга>/
            targetDir = path.join(monthDir, catDirName);
          }

          fs.mkdirSync(targetDir, { recursive: true });

          const fileName = path.basename(bill.filePath);
          const destPath = path.join(targetDir, fileName);
          fs.copyFileSync(bill.filePath, destPath);
          placed.push(destPath);
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `Счета разложены в папку месяца: ${monthName}\n` +
                `Размещено файлов: ${placed.length}\n` +
                placed.map((p, i) => `  ${i + 1}. ${p}`).join('\n')
            }
          ],
          structuredContent: {
            monthName,
            monthDir,
            placedCount: placed.length,
            placedFiles: placed
          }
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Ошибка раскладывания счетов: ${String(error)}` }]
        };
      }
    }
  );
}

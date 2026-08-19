import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { AgentTool } from './types.js';

// Base directory for storing documents by month
export const BASE_DIR = '/home/geekonclick/Рабочий стол/Администрирование2026/Документы по месяцам';

// Month names in Russian with capital first letter
export const MONTH_NAMES_RU: Record<number, string> = {
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
export const CATEGORIES_WITH_1292 = new Set(['electricity', 'heat']);

// Category -> folder name mapping (matching the July example structure)
export const CATEGORY_DIR_NAMES: Record<string, string> = {
  electricity: 'электро',
  heat: 'тепло',
  water: 'Водоканал',
  garbage: 'Нижэкология',
  maintenance: 'Наш дом'
};

/** Возвращает путь к папке текущего месяца (на русском) внутри BASE_DIR. */
export function getCurrentMonthDir(baseDir: string = BASE_DIR): string {
  const now = new Date();
  const monthName = MONTH_NAMES_RU[now.getMonth()];
  return path.join(baseDir, monthName);
}

/** Возвращает путь к папке конкретной категории внутри папки месяца. */
export function getCategoryDir(monthDir: string, category: string): string | null {
  const catDirName = CATEGORY_DIR_NAMES[category];
  if (!catDirName) {
    return null;
  }
  if (CATEGORIES_WITH_1292.has(category)) {
    return path.join(monthDir, '1292', catDirName);
  }
  return path.join(monthDir, catDirName);
}

export const organizeBillsSchema = z.object({
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
});

export type OrganizeBillsInput = z.output<typeof organizeBillsSchema>;

export const EXPECTED_AMOUNT_MANIFEST_FILE = '_expected_amount.json';

export interface ExpectedAmountManifest {
  billFiles: string[];
}

export interface OrganizeBillsResult {
  monthName: string;
  monthDir: string;
  placedCount: number;
  placedFiles: string[];
}

/**
 * Рекурсивно удаляет все служебные манифесты _expected_amount.json внутри указанной
 * директории (используется по завершении агентского цикла для очистки папки).
 * Возвращает количество удалённых файлов.
 */
export function deleteExpectedAmountManifests(dir: string): number {
  let deletedCount = 0;

  if (!fs.existsSync(dir)) {
    return deletedCount;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      deletedCount += deleteExpectedAmountManifests(entryPath);
    } else if (entry.isFile() && entry.name === EXPECTED_AMOUNT_MANIFEST_FILE) {
      fs.unlinkSync(entryPath);
      deletedCount += 1;
    }
  }

  return deletedCount;
}

export const organizeBillsTool: AgentTool<typeof organizeBillsSchema, OrganizeBillsResult> = {
  name: 'organize_bills',
  title: 'Разложить счета по папкам',
  description:
    'Создаёт директорию текущего месяца (на русском) в /home/geekonclick/Рабочий стол/Администрирование2026/Документы по месяцам, ' +
    'подпапки по категориям услуг и копирует туда файлы счетов. ' +
    'Для электричества (electricity) и теплоэнергии (heat) создаётся промежуточная папка 1292.',
  schema: organizeBillsSchema,

  async execute({ bills }): Promise<OrganizeBillsResult> {
    const now = new Date();
    const monthName = MONTH_NAMES_RU[now.getMonth()];
    const monthDir = path.join(BASE_DIR, monthName);

    const placed: string[] = [];
    const manifestByDir: Record<string, ExpectedAmountManifest> = {};

    for (const bill of bills) {
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

      const manifest = manifestByDir[targetDir] || { billFiles: [] };
      manifest.billFiles.push(fileName);
      manifestByDir[targetDir] = manifest;
    }

    // Сохраняем манифест со списком файлов счетов в каждой папке, чтобы при проверке
    // квитанций можно было отличить исходные счета от прочих документов
    for (const [dir, manifest] of Object.entries(manifestByDir)) {
      fs.writeFileSync(
        path.join(dir, EXPECTED_AMOUNT_MANIFEST_FILE),
        JSON.stringify(manifest, null, 2),
        'utf8'
      );
    }

    return {
      monthName,
      monthDir,
      placedCount: placed.length,
      placedFiles: placed
    };
  }
};

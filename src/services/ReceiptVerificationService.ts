import fs from 'node:fs';
import path from 'node:path';
import { agentModelRouter } from '../llm/routing/model-router.js';
import {
  BASE_DIR,
  CATEGORY_DIR_NAMES,
  EXPECTED_AMOUNT_MANIFEST_FILE,
  ExpectedAmountManifest,
  getCurrentMonthDir
} from '../mcp/tools/organize-bills.tool.js';

export interface ReceiptFileCheck {
  file: string;
  isReceipt: boolean;
  issue: string | null;
}

export interface FolderReceiptCheckResult {
  category: string;
  dir: string;
  /** Файлы, классифицированные моделью как квитанции/чеки */
  receiptFiles: string[];
  /** Файлы в папке, которые не являются ни счётом, ни квитанцией (УПД, акты и т.п.) */
  ignoredFiles: string[];
  ok: boolean;
  issue: string | null;
}

export interface ReceiptsCheckResult {
  ok: boolean;
  checkedFolders: FolderReceiptCheckResult[];
}

/**
 * Проверяет, что в каждой папке, куда были разложены счета (organize_bills),
 * фактически присутствует хотя бы одна квитанция/чек об оплате. Сравнение сумм не выполняется.
 *
 * Решение о режиме (EASY/HARD) для всей задачи `bills` (включая проверку квитанций) принимает
 * единый `agentModelRouter` (см. llm/routing/model-router.ts) — сейчас для задачи `bills` это
 * всегда HARD, т.е. RouterAI. Используемая модель логируется в консоль.
 */
export class ReceiptVerificationService {

  private findManifestDirs(monthDir: string): string[] {
    const found: string[] = [];

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) {
        return;
      }
      const manifestPath = path.join(dir, EXPECTED_AMOUNT_MANIFEST_FILE);
      if (fs.existsSync(manifestPath)) {
        found.push(dir);
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name));
        }
      }
    };

    walk(monthDir);
    return found;
  }

  /** Все файлы в папке, кроме самих счётов и служебного манифеста — кандидаты на квитанции. */
  private findReceiptCandidates(dir: string, manifest: ExpectedAmountManifest): string[] {
    const billFilesSet = new Set(manifest.billFiles);
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const candidates: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === EXPECTED_AMOUNT_MANIFEST_FILE) continue;
      if (billFilesSet.has(entry.name)) continue;
      candidates.push(path.join(dir, entry.name));
    }

    return candidates;
  }

  /**
   * Классифицирует один файл-кандидат (чек/квитанция или иной документ). Решение о режиме
   * (EASY/HARD) принимает `agentModelRouter` перед вызовом — сама проверка не выбирает модель.
   */
  private async classifyCandidate(filePath: string): Promise<ReceiptFileCheck> {
    try {
      const modelResult = await agentModelRouter.verifyReceiptFile(filePath);
      return { file: filePath, isReceipt: modelResult.isReceipt, issue: modelResult.issue };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { file: filePath, isReceipt: false, issue: `Ошибка классификации документа: ${msg}` };
    }
  }

  private resolveCategory(dir: string): string {
    const match = Object.entries(CATEGORY_DIR_NAMES).find(([, folderName]) => dir.endsWith(folderName));
    return match ? match[0] : path.basename(dir);
  }

  /**
   * Проверяет все папки текущего (или переданного) месяца, в которые ранее были
   * разложены счета через organize_bills, на фактическое наличие квитанции об оплате.
   *
   * Алгоритм для каждой папки:
   * 1. Все файлы, кроме исходных счётов и манифеста, классифицируются через RouterAI (режим HARD):
   *    является ли файл квитанцией/чеком об оплате (а не УПД/актом/договором и т.п.).
   * 2. Файлы, признанные не квитанциями, игнорируются (ignoredFiles).
   * 3. Если найден хотя бы один файл, признанный квитанцией/чеком — папка считается проверенной успешно. Суммы не сравниваются.
   */
  async checkAllFolders(monthDir: string = getCurrentMonthDir(BASE_DIR)): Promise<ReceiptsCheckResult> {
    const dirs = this.findManifestDirs(monthDir);
    const checkedFolders: FolderReceiptCheckResult[] = [];

    for (const dir of dirs) {
      const manifestPath = path.join(dir, EXPECTED_AMOUNT_MANIFEST_FILE);
      const manifest: ExpectedAmountManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const category = this.resolveCategory(dir);

      const candidateFiles = this.findReceiptCandidates(dir, manifest);

      if (candidateFiles.length === 0) {
        checkedFolders.push({
          category,
          dir,
          receiptFiles: [],
          ignoredFiles: [],
          ok: false,
          issue: `В папке отсутствует квитанция (чек) об оплате.`
        });
        continue;
      }

      const receiptFiles: string[] = [];
      const ignoredFiles: string[] = [];

      for (const candidate of candidateFiles) {
        const check = await this.classifyCandidate(candidate);

        if (!check.isReceipt) {
          // Не квитанция (УПД, акт, договор и т.п.) — игнорируется, не считается ошибкой.
          ignoredFiles.push(candidate);
          continue;
        }

        receiptFiles.push(candidate);
      }

      if (receiptFiles.length === 0) {
        checkedFolders.push({
          category,
          dir,
          receiptFiles: [],
          ignoredFiles,
          ok: false,
          issue: `В папке отсутствует квитанция (чек) об оплате — найденные документы (${ignoredFiles.map((f) => path.basename(f)).join(', ')}) не являются квитанциями.`
        });
        continue;
      }

      checkedFolders.push({
        category,
        dir,
        receiptFiles,
        ignoredFiles,
        ok: true,
        issue: null
      });
    }

    return {
      ok: checkedFolders.length > 0 && checkedFolders.every((f) => f.ok),
      checkedFolders
    };
  }
}

export const receiptVerificationService = new ReceiptVerificationService();

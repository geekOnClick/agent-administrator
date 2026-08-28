import path from 'path';
import { DocumentsService } from './DocumentsService.js';
import { BillValidationResult } from './RouterAIService.js';
import { agentModelRouter } from '../llm/routing/model-router.js';
import { BILL_CATEGORY_LABELS, BillCategory } from '../llm/prompts.js';
import { YandexDiskService } from './YandexDiskService.js';
import { ReceiptsCheckResult } from './ReceiptVerificationService.js';
import { DocxBillsTableService } from './DocxBillsTableService.js';
import { billsLedgerVectorService } from './vector/BillsLedgerVectorService.js';
import { deleteExpectedAmountManifests } from '../tools/organize-bills.tool.js';
import { callTool } from '../tools/registry.js';
import { config } from '../config.js';
import { BillsRunTracker } from '../observability/BillsRunTracker.js';
import type { BillsRunReport } from '../observability/types.js';

export type BillsCyclePhase = 'idle' | 'running' | 'awaitingPayment';

export type BillsCycleStepResult =
  | {
      kind: 'validation';
      validation: BillValidationResult;
    }
  | {
      kind: 'receiptsFailed';
      receipts: ReceiptsCheckResult;
      failed: { category: string; dir: string; issue: string }[];
    }
  | {
      kind: 'sordisuGenerated';
      sordisu: SordisuBillResult;
      excludedCategories: BillCategory[];
      receipts: ReceiptsCheckResult;
    };

export interface SordisuBillResult {
  monthDir: string;
  pdfPath: string;
  spravkaPdfPath?: string;
  spravkaTotalWithVat?: number;
  spravkaWarnings?: string[];
  kommunalkaPdfPath?: string;
  copiedOrganizedDocsCount?: number;
  excludedCategories?: BillCategory[];
}

/**
 * Оркестрация ReAct-цикла обработки счетов (команды bills / retry / continue):
 * скачивание документов с Яндекс.Диска, валидация категорий через RouterAI,
 * раскладывание по папкам, проверка квитанций и генерация итоговых документов
 * "Сордису". Состояние цикла (когда валидировать, когда ждать оплату) живёт
 * здесь, а не в клиенте и не в LLM-инфраструктуре.
 */
export class BillsCycleService {
  private docsService: DocumentsService;
  private yandexDiskService: YandexDiskService;
  private docxBillsTableService: DocxBillsTableService;
  private ledgerVectorService = billsLedgerVectorService;
  private billsCyclePhase: BillsCyclePhase = 'idle';
  /** Трекер observability текущего запуска цикла bills. */
  private runTracker: BillsRunTracker | null = null;

  constructor() {
    this.docsService = new DocumentsService();
    this.yandexDiskService = new YandexDiskService();
    this.docxBillsTableService = new DocxBillsTableService();
  }

  getBillsCyclePhase(): BillsCyclePhase {
    return this.billsCyclePhase;
  }

  /**
   * Запускает новый ReAct-цикл валидации счетов (команда bills).
   * Сбрасывает предыдущее состояние цикла.
   */
  async startBillsCycle(): Promise<BillsCycleStepResult> {
    this.billsCyclePhase = 'running';
    // Создаём новый трекер observability для каждого нового запуска цикла.
    this.runTracker = BillsRunTracker.create();
    this.runTracker.incValidationAttempts();
    return this.runBillsValidationStep();
  }

  /**
   * Повторная итерация цикла (команда retry) — только если цикл запущен
   * и не ожидает оплаты. Автоматически прерывает цикл, если число
   * попыток валидации достигло лимита (BILLS_MAX_VALIDATION_ATTEMPTS, дефолт: 5).
   */
  async retryBillsCycle(): Promise<BillsCycleStepResult> {
    if (this.billsCyclePhase === 'idle') {
      throw new Error('Нет активного ReAct-цикла. Сначала выполните команду bills.');
    }
    if (this.billsCyclePhase === 'awaitingPayment') {
      throw new Error('Цикл ожидает оплаты. Напечатайте continue после оплаты счетов.');
    }

    // Проверяем лимит перед инкрементом: bills уже засчитал первую попытку,
    // поэтому (validationAttempts ≥ maxValidationAttempts) — прерываем.
    const max = config.bills.maxValidationAttempts;
    const current = this.runTracker?.getValidationAttempts() ?? 0;
    if (current >= max) {
      const msg =
        `Превышен лимит попыток валидации: ${current} из ${max} допустимых. ` +
        `Агентский loop прерван. Проверьте документы и начните новый цикл командой bills.`;
      console.error(`⛔ [ReAct] ${msg}`);
      this.billsCyclePhase = 'idle';
      this.runTracker?.finish('failed');
      this.runTracker = null;
      throw new Error(msg);
    }

    this.runTracker?.incValidationAttempts();
    return this.runBillsValidationStep();
  }

  /**
   * Возобновление цикла после оплаты (команды continue / continue!).
   * Проверяет квитанции; при полном успехе или force — генерирует итоговые
   * документы "Сордису" и завершает цикл (phase -> idle).
   */
  async continueBillsCycle(force: boolean): Promise<BillsCycleStepResult> {
    if (this.billsCyclePhase !== 'awaitingPayment') {
      throw new Error(
        `Цикл не приостановлен на ожидании оплаты. Команда ${force ? 'continue!' : 'continue'} сейчас не нужна.`
      );
    }

    this.runTracker?.incContinueAttempts();

    try {
      const receipts = await this.checkBillReceipts();

      if (!receipts.ok && !force) {
        return {
          kind: 'receiptsFailed',
          receipts,
          failed: this.getFailedReceiptFolders(receipts)
        };
      }

      const excludedCategories = receipts.ok ? [] : this.getFailedReceiptCategoryKeys(receipts);
      this.runTracker?.setExcludedCategories(excludedCategories);
      const sordisu = await this.generateSordisuBill(excludedCategories);
      this.billsCyclePhase = 'idle';

      // Финализируем трекер observability: outcome зависит от наличия исключённых категорий.
      const outcome: BillsRunReport['outcome'] = force && excludedCategories.length > 0
        ? 'successForced'
        : 'success';
      this.runTracker?.finish(outcome);
      this.runTracker = null;

      return { kind: 'sordisuGenerated', sordisu, excludedCategories, receipts };
    } catch (err) {
      // Фатальная ошибка на этапе continue — финализируем трекер как failed и пробрасываем выше.
      this.runTracker?.finish('failed');
      this.runTracker = null;
      throw err;
    }
  }

  /**
   * Одна итерация валидации: скачать документы, валидировать, разложить по папкам.
   * При фатальной ошибке (исключении) цикл остаётся в 'running', чтобы retry был
   * доступен; при успешной валидации переходит в 'awaitingPayment'.
   */
  private async runBillsValidationStep(): Promise<BillsCycleStepResult> {
    try {
      const validation = await this.runBillsReactCycle();
      if (validation.valid) {
        this.billsCyclePhase = 'awaitingPayment';
      }
      return { kind: 'validation', validation };
    } catch (err) {
      // Фатальная ошибка (исключение из цикла) — цикл остаётся активным для retry,
      // но не в состоянии ожидания оплаты.
      this.billsCyclePhase = 'running';
      throw err;
    }
  }

  /**
   * ReAct-цикл обработки счётов:
   * 1. Скачивает документы с Яндекс.Диска
   * 2. Отправляет документы на валидацию категорий в RouterAI
   * 3. При успешной валидации — раскладывает файлы по папкам (organize_bills)
   * 4. Дозаписывает таблицу учёта и актуализирует векторную базу
   */
  private async runBillsReactCycle(): Promise<BillValidationResult> {
    const docsDir = path.resolve(process.cwd(), 'docs');

    // Шаг 1: Скачиваем документы с Яндекс.Диска напрямую
    console.log('\n🤖 [ReAct] Шаг 1: скачиваю документы с Яндекс.Диска...');
    const endDownload = this.runTracker?.beginStep('downloadDocs');
    try {
      const downloadedFiles = await this.yandexDiskService.syncDocsToLocal(docsDir);
      console.log(`✅ [ReAct] Скачано файлов: ${downloadedFiles.length}`);
      endDownload?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [ReAct] Ошибка скачивания: ${msg}`);
      this.runTracker?.failStep('downloadDocs', msg);
      this.runTracker?.setCoveredCategories([], Object.keys(BILL_CATEGORY_LABELS) as BillCategory[]);
      this.runTracker?.finish('failed');
      this.runTracker = null;
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: Object.keys(BILL_CATEGORY_LABELS) as BillCategory[],
        errors: [`Ошибка скачивания с Яндекс.Диска: ${msg}`],
        details: []
      };
    }

    // Шаг 2: Собираем файлы из docs
    console.log(`\n🤖 [ReAct] Шаг 2: анализ документов...`);
    let filePaths: string[];
    const endValidate = this.runTracker?.beginStep('validateCategories');
    try {
      filePaths = this.docsService.resolveBillFilePaths([docsDir]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [ReAct] Не удалось собрать файлы: ${msg}`);
      this.runTracker?.failStep('validateCategories', msg);
      this.runTracker?.setCoveredCategories([], Object.keys(BILL_CATEGORY_LABELS) as BillCategory[]);
      this.runTracker?.finish('failed');
      this.runTracker = null;
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: Object.keys(BILL_CATEGORY_LABELS) as BillCategory[],
        errors: [msg],
        details: []
      };
    }

    // Шаг 3: Отправляем документы на валидацию (единый роутер определяет режим для
    // задачи bills — сейчас всегда HARD — и только затем обращается к RouterAI)
    let validation: BillValidationResult;
    try {
      validation = await agentModelRouter.validateBillCategories(filePaths);
      endValidate?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTokenError = err instanceof Error && (err as any).isTokenError === true;
      this.runTracker?.failStep('validateCategories', msg);
      this.runTracker?.setCoveredCategories([], Object.keys(BILL_CATEGORY_LABELS) as BillCategory[]);
      this.runTracker?.finish('failed');
      this.runTracker = null;
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: Object.keys(BILL_CATEGORY_LABELS) as BillCategory[],
        errors: [msg],
        details: [],
        isTokenError
      };
    }

    // Сохраняем покрытые/отсутствующие категории после валидации
    this.runTracker?.setCoveredCategories(
      validation.coveredCategories ?? [],
      validation.missingCategories ?? []
    );

    // Шаг 4: Если валидация прошла успешно — организуем файлы прямым вызовом инструмента
    if (validation.valid && validation.details && validation.details.length > 0) {
      console.log('\n🤖 [ReAct] Шаг 4: раскладываю счета по папкам...');
      const endOrganize = this.runTracker?.beginStep('organizeBills');
      try {
        // Строим массив {filePath, category} напрямую из details валидации
        // — не через модель, чтобы исключить потери из-за парсинга LLM
        const bills = validation.details
          .filter((d) => d.category !== null)
          .map((d) => {
            const fullPath =
              filePaths.find((fp) => path.basename(fp) === d.file) ||
              path.join(docsDir, d.file);
            return {
              filePath: fullPath,
              category: d.category as BillCategory
            };
          });

        console.log(`  Счета для раскладывания (${bills.length}):`);
        for (const b of bills) {
          console.log(`    • ${path.basename(b.filePath)} → ${b.category}`);
        }

        const organizeResult = await callTool('organize_bills', { bills });
        console.log(
          `✅ [ReAct] Организация завершена: размещено файлов — ${organizeResult.placedCount}, папка месяца — ${organizeResult.monthDir}`
        );
        endOrganize?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  [ReAct] Ошибка при организации файлов: ${msg}`);
        this.runTracker?.failStep('organizeBills', msg);
        // Не прерываем — возвращаем validation как есть
      }

      // Шаг 5: Заполняем (дозаписываем) таблицу учёта коммунальных платежей
      // новой строкой с суммами по категориям текущего месяца.
      console.log('\n🤖 [ReAct] Шаг 5: заполняю таблицу учёта коммунальных платежей...');
      const endLedger = this.runTracker?.beginStep('appendLedgerRow');
      try {
        const amountsByCategory: Partial<Record<BillCategory, number>> = {};
        for (const d of validation.details) {
          if (d.category && d.hasAmount && typeof d.amount === 'number') {
            // Защита от NaN/Infinity, которые проходят проверку typeof === 'number'.
            if (!Number.isFinite(d.amount)) {
              console.warn(
                `⚠️  [ReAct] Невалидная сумма из LLM для ${d.category}: ${d.amount} (файл: ${d.file}) — пропущена.`
              );
              continue;
            }
            // Если в категории несколько счетов (например, 2 счета водоканала),
            // суммируем их итоговые суммы для таблицы учёта.
            amountsByCategory[d.category] = (amountsByCategory[d.category] ?? 0) + d.amount;
          }
        }

        // Логируем итоговые суммы по категориям перед записью в таблицу
        console.log('  Итоговые суммы по категориям:');
        for (const [cat, amount] of Object.entries(amountsByCategory)) {
          const label = BILL_CATEGORY_LABELS[cat as BillCategory] || cat;
          console.log(`    • ${label}: ${amount?.toFixed(2)} руб.`);
        }

        const appendResult = await this.docxBillsTableService.appendMonthlyRow(
          config.bills.ledgerDocxPath,
          amountsByCategory
        );
        console.log(
          `✅ [ReAct] В таблицу учёта добавлена строка «${appendResult.monthLabel}»: ${config.bills.ledgerDocxPath}`
        );
        endLedger?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  [ReAct] Ошибка при заполнении таблицы учёта: ${msg}`);
        this.runTracker?.failStep('appendLedgerRow', msg);
        // Не прерываем — возвращаем validation как есть
      }

      // Шаг 6: Актуализируем векторную базу данных (FalkorDB) данными
      // обновлённой таблицы учёта, чтобы режим ask отвечал по свежим данным.
      console.log('\n🤖 [ReAct] Шаг 6: актуализирую векторную базу данных таблицы учёта...');
      const endSync = this.runTracker?.beginStep('syncVectorStore');
      try {
        const syncResult = await this.ledgerVectorService.syncLedgerToVectorStore(config.bills.ledgerDocxPath);
        console.log(`✅ [ReAct] Векторная база обновлена: проиндексировано строк — ${syncResult.rowsIndexed}`);
        // Передаём статистику чтения таблицы в трекер для оценки SM-7.
        this.runTracker?.setTableReadStats(syncResult.stats);
        endSync?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  [ReAct] Ошибка при актуализации векторной базы: ${msg}`);
        this.runTracker?.failStep('syncVectorStore', msg);
        // Не прерываем — возвращаем validation как есть
      }
    } else if (!validation.valid) {
      // Валидация не прошла — шаги 4-6 пропущены
      this.runTracker?.skipStep('organizeBills', 'validation not passed');
      this.runTracker?.skipStep('appendLedgerRow', 'validation not passed');
      this.runTracker?.skipStep('syncVectorStore', 'validation not passed');
    }

    // Шаг 7: Удаляем служебные манифесты _expected_amount.json из папки со скачанными
    // документами — они больше не нужны после раскладывания счетов по папкам.
    const endCleanup = this.runTracker?.beginStep('cleanupManifests');
    try {
      const deletedCount = deleteExpectedAmountManifests(docsDir);
      if (deletedCount > 0) {
        console.log(`🧹 [ReAct] Удалено служебных манифестов _expected_amount.json: ${deletedCount}`);
      }
      endCleanup?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`⚠️  [ReAct] Ошибка при удалении манифестов _expected_amount.json: ${msg}`);
      this.runTracker?.failStep('cleanupManifests', msg);
    }

    return validation;
  }

  /**
   * Вызывает инструмент check_bill_receipts: для каждой папки со счетами
   * (разложенной organize_bills) проверяет только фактическое наличие квитанции (чека) об оплате
   * в папке (без сравнения сумм). Классификация каждого файла всегда выполняется
   * в режиме HARD через RouterAI.
   */
  async checkBillReceipts(monthDir?: string): Promise<ReceiptsCheckResult> {
    await agentModelRouter.resolveModeWithLog('bills', 'Проверка квитанций (continue)');

    const endCheck = this.runTracker?.beginStep('checkReceipts');
    try {
      const check = await callTool('check_bill_receipts', monthDir ? { monthDir } : {});
      endCheck?.();
      return check;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runTracker?.failStep('checkReceipts', msg);
      throw err;
    }
  }

  /**
   * Вызывает инструмент generate_sordisu_bill: создаёт папку текущего месяца
   * в "Сордису по месяцам", копирует туда шаблон и заполняет актуальные даты в счёте.doc,
   * сохраняет результат в pdf и удаляет исходный .doc.
   */
  async generateSordisuBill(excludeCategories: BillCategory[] = []): Promise<SordisuBillResult> {
    const endSordisu = this.runTracker?.beginStep('generateSordisu');
    try {
      const result = await callTool(
        'generate_sordisu_bill',
        excludeCategories.length > 0 ? { excludeCategories } : {}
      );
      endSordisu?.();
      return {
        monthDir: result.monthDir,
        pdfPath: result.pdfPath,
        spravkaPdfPath: result.spravkaPdfPath,
        spravkaTotalWithVat: result.spravkaTotalWithVat,
        spravkaWarnings: result.spravkaWarnings,
        kommunalkaPdfPath: result.kommunalkaPdfPath,
        copiedOrganizedDocsCount: result.copiedOrganizedDocsCount,
        excludedCategories: result.excludedCategories as BillCategory[]
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.runTracker?.failStep('generateSordisu', msg);
      throw err;
    }
  }

  /**
   * Форматирует человекочитаемый отчёт о проверке квитанций.
   */
  formatReceiptsCheckReport(result: ReceiptsCheckResult): string {
    const lines: string[] = [];

    if (result.ok) {
      lines.push('✅ Во всех папках найдены квитанции с корректными суммами.');
    } else {
      lines.push('❌ Обнаружены проблемы с квитанциями об оплате.');
    }

    for (const f of result.checkedFolders) {
      const status = f.ok ? '✓' : '✗';
      const label = BILL_CATEGORY_LABELS[f.category as BillCategory] || f.category;
      const receiptNames = f.receiptFiles.length > 0 ? f.receiptFiles.map((r) => path.basename(r)).join(', ') : '—';
      const issue = f.issue ? ` — ${f.issue}` : '';
      lines.push(`  ${status} ${label} (📁 ${f.dir}): квитанции [${receiptNames}]${issue}`);
    }

    return lines.join('\n');
  }

  /**
   * Возвращает список папок, в которых проверка квитанции не пройдена
   * (нет квитанции или сумма не совпадает), с человекочитаемым названием категории.
   */
  getFailedReceiptFolders(result: ReceiptsCheckResult): { category: string; dir: string; issue: string }[] {
    return result.checkedFolders
      .filter((f) => !f.ok)
      .map((f) => ({
        category: BILL_CATEGORY_LABELS[f.category as BillCategory] || f.category,
        dir: f.dir,
        issue: f.issue || 'квитанция об оплате не найдена.'
      }));
  }

  /**
   * Возвращает сырые ключи категорий (BillCategory), в папках которых не найдена квитанция
   * об оплате. Используется, чтобы исключить эти категории из итогового счёта "Сордису"
   * при вынужденном продолжении цикла (continue!).
   */
  getFailedReceiptCategoryKeys(result: ReceiptsCheckResult): BillCategory[] {
    return result.checkedFolders
      .filter((f) => !f.ok)
      .map((f) => f.category as BillCategory);
  }

  /**
   * Форматирует человекочитаемый отчёт о валидации.
   */
  formatValidationReport(validation: BillValidationResult): string {
    if (validation.errors && validation.errors.length > 0 && !validation.valid && validation.coveredCategories.length === 0) {
      const errLines = validation.errors.map((e) => `  • ${e}`).join('\n');
      return `❌ Ошибка:\n${errLines}`;
    }

    const lines: string[] = [];

    if (validation.valid) {
      lines.push('✅ Все счета успешно валидированы по всем категориям.');
    } else {
      lines.push('⚠️  Валидация не прошла.');
    }

    if (validation.coveredCategories?.length > 0) {
      lines.push(`✅ Найдены счета по категориям:`);
      for (const cat of validation.coveredCategories) {
        lines.push(`  ✓ ${BILL_CATEGORY_LABELS[cat] || cat}`);
      }
    }

    if (validation.missingCategories?.length > 0) {
      lines.push(`❌ Не хватает счетов по категориям:`);
      for (const cat of validation.missingCategories) {
        lines.push(`  • ${BILL_CATEGORY_LABELS[cat] || cat}`);
      }
    }

    if (validation.errors?.length > 0) {
      lines.push(`❌ Ошибки:`);
      for (const err of validation.errors) {
        lines.push(`  • ${err}`);
      }
    }

    if (validation.details?.length > 0) {
      lines.push(`ℹ️  Детализация:`);
      let totalAmount = 0;
      for (const d of validation.details) {
        const cat = d.category ? (BILL_CATEGORY_LABELS[d.category] || d.category) : 'не определена';
        const amount =
          d.hasAmount && typeof d.amount === 'number'
            ? `${d.amount.toFixed(2)} руб.`
            : 'СУММА ОТСУТСТВУЕТ';
        if (d.hasAmount && typeof d.amount === 'number') {
          totalAmount += d.amount;
        }
        const issue = d.issue ? ` | • ${d.issue}` : '';
        lines.push(`  - ${d.file}: [${cat}] ${amount}${issue}`);
      }
      lines.push(`ИТОГО К ОПЛАТЕ: ${totalAmount.toFixed(2)} руб.`);
    }

    return lines.join('\n');
  }
}

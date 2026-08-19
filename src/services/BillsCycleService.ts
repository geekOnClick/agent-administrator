import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import path from 'path';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DocumentsService } from './DocumentsService.js';
import { BillValidationResult } from './RouterAIService.js';
import { agentModelRouter } from '../llm/routing/model-router.js';
import { BILL_CATEGORY_LABELS, BillCategory } from '../llm/prompts.js';
import { YandexDiskService } from './YandexDiskService.js';
import { ReceiptsCheckResult } from './ReceiptVerificationService.js';
import { DocxBillsTableService } from './DocxBillsTableService.js';
import { billsLedgerVectorService } from './vector/BillsLedgerVectorService.js';
import { deleteExpectedAmountManifests } from '../mcp/tools/organize-bills.tool.js';
import { config, mcpCallOptions } from '../config.js';

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

  constructor(private readonly mcp: Client) {
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
    return this.runBillsValidationStep();
  }

  /**
   * Повторная итерация цикла (команда retry) — только если цикл запущен
   * и не ожидает оплаты.
   */
  async retryBillsCycle(): Promise<BillsCycleStepResult> {
    if (this.billsCyclePhase === 'idle') {
      throw new Error('Нет активного ReAct-цикла. Сначала выполните команду bills.');
    }
    if (this.billsCyclePhase === 'awaitingPayment') {
      throw new Error('Цикл ожидает оплаты. Напечатайте continue после оплаты счетов.');
    }
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

    const receipts = await this.checkBillReceipts();

    if (!receipts.ok && !force) {
      return {
        kind: 'receiptsFailed',
        receipts,
        failed: this.getFailedReceiptFolders(receipts)
      };
    }

    const excludedCategories = receipts.ok ? [] : this.getFailedReceiptCategoryKeys(receipts);
    const sordisu = await this.generateSordisuBill(excludedCategories);
    this.billsCyclePhase = 'idle';
    return { kind: 'sordisuGenerated', sordisu, excludedCategories, receipts };
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
    try {
      const downloadedFiles = await this.yandexDiskService.syncDocsToLocal(docsDir);
      console.log(`✅ [ReAct] Скачано файлов: ${downloadedFiles.length}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [ReAct] Ошибка скачивания: ${msg}`);
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
    try {
      filePaths = this.docsService.resolveBillFilePaths([docsDir]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [ReAct] Не удалось собрать файлы: ${msg}`);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTokenError = err instanceof Error && (err as any).isTokenError === true;
      return {
        valid: false,
        coveredCategories: [],
        missingCategories: Object.keys(BILL_CATEGORY_LABELS) as BillCategory[],
        errors: [msg],
        details: [],
        isTokenError
      };
    }

    // Шаг 4: Если валидация прошла успешно — организуем файлы напрямую через MCP
    if (validation.valid && validation.details && validation.details.length > 0) {
      console.log('\n🤖 [ReAct] Шаг 4: раскладываю счета по папкам...');
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
              category: d.category as string
            };
          });

        console.log(`  Счета для раскладывания (${bills.length}):`);
        for (const b of bills) {
          console.log(`    • ${path.basename(b.filePath)} → ${b.category}`);
        }

        const organizeResult = await this.mcp.callTool(
          {
            name: 'organize_bills',
            arguments: { bills }
          },
          CallToolResultSchema,
          mcpCallOptions()
        );

        const resultText = (organizeResult.content as any[])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
        console.log(`✅ [ReAct] Организация завершена:\n${resultText}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  [ReAct] Ошибка при организации файлов: ${msg}`);
        // Не прерываем — возвращаем validation как есть
      }

      // Шаг 5: Заполняем (дозаписываем) таблицу учёта коммунальных платежей
      // новой строкой с суммами по категориям текущего месяца.
      console.log('\n🤖 [ReAct] Шаг 5: заполняю таблицу учёта коммунальных платежей...');
      try {
        const amountsByCategory: Partial<Record<BillCategory, number>> = {};
        for (const d of validation.details) {
          if (d.category && d.hasAmount && typeof d.amount === 'number') {
            amountsByCategory[d.category] = d.amount;
          }
        }

        const appendResult = await this.docxBillsTableService.appendMonthlyRow(
          config.bills.ledgerDocxPath,
          amountsByCategory
        );
        console.log(
          `✅ [ReAct] В таблицу учёта добавлена строка «${appendResult.monthLabel}»: ${config.bills.ledgerDocxPath}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  [ReAct] Ошибка при заполнении таблицы учёта: ${msg}`);
        // Не прерываем — возвращаем validation как есть
      }

      // Шаг 6: Актуализируем векторную базу данных (FalkorDB) данными
      // обновлённой таблицы учёта, чтобы режим ask отвечал по свежим данным.
      console.log('\n🤖 [ReAct] Шаг 6: актуализирую векторную базу данных таблицы учёта...');
      try {
        const syncResult = await this.ledgerVectorService.syncLedgerToVectorStore(config.bills.ledgerDocxPath);
        console.log(`✅ [ReAct] Векторная база обновлена: проиндексировано строк — ${syncResult.rowsIndexed}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  [ReAct] Ошибка при актуализации векторной базы: ${msg}`);
        // Не прерываем — возвращаем validation как есть
      }
    }

    // Шаг 7: Удаляем служебные манифесты _expected_amount.json из папки со скачанными
    // документами — они больше не нужны после раскладывания счетов по папкам.
    try {
      const deletedCount = deleteExpectedAmountManifests(docsDir);
      if (deletedCount > 0) {
        console.log(`🧹 [ReAct] Удалено служебных манифестов _expected_amount.json: ${deletedCount}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`⚠️  [ReAct] Ошибка при удалении манифестов _expected_amount.json: ${msg}`);
    }

    return validation;
  }

  /**
   * Вызывает MCP-инструмент check_bill_receipts: для каждой папки со счетами
   * (разложенной organize_bills) проверяет только фактическое наличие квитанции (чека) об оплате
   * в папке (без сравнения сумм). Классификация каждого файла всегда выполняется
   * в режиме HARD через RouterAI.
   */
  async checkBillReceipts(monthDir?: string): Promise<ReceiptsCheckResult> {
    await agentModelRouter.resolveModeWithLog('bills', 'Проверка квитанций (continue)');

    let result;
    try {
      result = await this.mcp.callTool(
        {
          name: 'check_bill_receipts',
          arguments: monthDir ? { monthDir } : {}
        },
        CallToolResultSchema,
        mcpCallOptions()
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Проверка квитанций] Ошибка вызова check_bill_receipts: ${msg}`);
      throw err;
    }

    if (result.isError) {
      const text = (result.content as any[])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      console.error(`[Проверка квитанций] Инструмент вернул ошибку: ${text || 'Ошибка проверки квитанций'}`);
      throw new Error(text || 'Ошибка проверки квитанций');
    }

    const check = result.structuredContent as unknown as ReceiptsCheckResult;
    const foldersCount = check.checkedFolders.length;
    const okCount = check.checkedFolders.filter((f) => f.ok).length;
    console.log(
      `[Проверка квитанций] Выполнено: проверено папок — ${foldersCount}, с квитанциями — ${okCount}. Результат: ${check.ok ? 'OK' : 'есть проблемы'}.`
    );

    return check;
  }

  /**
   * Вызывает MCP-инструмент generate_sordisu_bill: создаёт папку текущего месяца
   * в "Сордису по месяцам", копирует туда шаблон и заполняет актуальные даты в счёте.doc,
   * сохраняет результат в pdf и удаляет исходный .doc.
   */
  async generateSordisuBill(excludeCategories: BillCategory[] = []): Promise<SordisuBillResult> {
    await agentModelRouter.resolveModeWithLog('bills', 'Подготовка счетов "Сордису"');

    const result = await this.mcp.callTool(
      {
        name: 'generate_sordisu_bill',
        arguments: excludeCategories.length > 0 ? { excludeCategories } : {}
      },
      CallToolResultSchema,
      mcpCallOptions()
    );

    if (result.isError) {
      const text = (result.content as any[])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      throw new Error(text || 'Ошибка генерации счёта "Сордису"');
    }

    return result.structuredContent as unknown as SordisuBillResult;
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

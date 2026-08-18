import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { AIHelperProvider, AIProvider } from './provider-factory.js';
import { AIHelperInterface, ToolDescriptor } from './types.js';
import { getSystemPromptByMode, LlmMode } from './prompts/profiles.js';
import { DocumentsService } from '../services/DocumentsService.js';
import { routerAIService, BillValidationResult } from '../services/RouterAIService.js';
import { BILL_CATEGORY_LABELS, BillCategory } from './prompts/profiles.js';
import { YandexDiskService } from '../services/YandexDiskService.js';
import { ReceiptsCheckResult } from '../services/ReceiptVerificationService.js';
import { DocxBillsTableService } from '../services/DocxBillsTableService.js';
import { billsLedgerVectorService } from '../services/vector/BillsLedgerVectorService.js';
import { billsPeriodReportService, parsePeriodArg, PeriodReportResult } from '../services/BillsPeriodReportService.js';
import { deleteExpectedAmountManifests } from '../mcp/tools/organize-bills.tool.js';

// Папка, в которую сохраняются отчёты режима "report".
const BILLS_REPORT_OUTPUT_DIR =
  process.env.BILLS_REPORT_OUTPUT_DIR || '/home/geekonclick/Рабочий стол/Администрирование2026';

// Путь к файлу таблицы учёта коммунальных платежей ("Администрирование_2_0.docx"),
// в который агент дозаписывает строку с суммами текущего месяца после успешной валидации.
const BILLS_LEDGER_DOCX_PATH =
  process.env.BILLS_LEDGER_DOCX_PATH ||
  '/home/geekonclick/Рабочий стол/Администрирование2026/Администрирование_2_0.docx';

// MCP-инструменты (organize_bills, check_bill_receipts) выполняют обращения к
// локальной/удалённой модели по каждой папке со счетами и могут занимать больше
// стандартного таймаута SDK (60 сек), поэтому увеличиваем лимиты для callTool.
const TOOL_CALL_TIMEOUT_MSEC = 10 * 60 * 1000; // 10 минут на попытку
const TOOL_CALL_MAX_TOTAL_TIMEOUT_MSEC = 30 * 60 * 1000; // 30 минут суммарно с учётом progress

export class ChatProcessor {
  ai: AIHelperInterface;
  private mcp: Client;
  private transport: StdioClientTransport;
  private tools: ToolDescriptor[] = [];
  private ollamaProcess: ChildProcess | null = null;
  private docsService: DocumentsService;
  private yandexDiskService: YandexDiskService;
  private docxBillsTableService: DocxBillsTableService;
  private ledgerVectorService = billsLedgerVectorService;

  constructor() {
    let strings = Object.values(AIProvider);
    let searchElement = process.env.AI_PROVIDER || 'ollama';
    if (!strings.includes(searchElement as any)) {
      throw new Error('Wrong AI provider');
    }
    this.ai = AIHelperProvider.getAiProvider(searchElement as any);
    this.mcp = new Client({ name: 'mcp-client-cli', version: '1.0.0' });
    this.transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/mcp/index.ts']
    });
    this.docsService = new DocumentsService();
    this.yandexDiskService = new YandexDiskService();
    this.docxBillsTableService = new DocxBillsTableService();
  }

  // инициализация модели, подключение mcp, tools
  async init() {
    const provider = process.env.AI_PROVIDER || 'ollama';
    if (provider === 'ollama') {
      const model = process.env.OLLAMA_MODEL || 'gemma4:e4b-8k';
      this.ollamaProcess = spawn('ollama', ['run', model], {
        stdio: 'ignore'
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    await this.mcp.connect(this.transport);
    this.tools = (await this.mcp.listTools()).tools as ToolDescriptor[];
  }

  private async ensureModePrompt(sessionId: string, mode: LlmMode): Promise<void> {
    await this.ai.setSessionSystemPrompt(sessionId, getSystemPromptByMode(mode));
  }

  // метод для вывода сообщения модели в формате стрима
  async *chatStream(
    sessionId: string,
    text: string,
    mode: LlmMode = 'ask'
  ): AsyncIterable<string> {
    await this.ensureModePrompt(sessionId, mode);

    if (this.ai.chatStream) {
      yield* this.ai.chatStream(sessionId, text);
    } else {
      const result = await this.processMessage(sessionId, text, mode);
      // Эмуляция печатания для провайдеров без стриминга
      for (const char of result.message) {
        yield char;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  // метод для ответа в chatStream и обычного ответа в Telegram
  async processMessage(
    sessionId: string,
    text: string,
    mode: LlmMode = 'ask'
  ): Promise<{
    message: string;
    tools: { name: string; arguments: Record<string, unknown> }[];
  }> {
    await this.ensureModePrompt(sessionId, mode);

    const toolsUsed: { name: string; arguments: Record<string, unknown> }[] = [];
    const finalOutput: string[] = [];

    const response = await this.ai.chatWithTools(sessionId, text, this.tools);
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        toolsUsed.push(call);
        console.log(`[Runtime] tool call -> ${call.name} ${JSON.stringify(call.arguments)}`);

        const result = await this.mcp.callTool(
          {
            name: call.name,
            arguments: call.arguments
          },
          CallToolResultSchema,
          { timeout: TOOL_CALL_TIMEOUT_MSEC, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_CALL_MAX_TOTAL_TIMEOUT_MSEC }
        );

        console.log(`[Runtime] tool result <- ${call.name}`);

        const arrayResult = result.content as any[];
        const flattened = arrayResult
          .map((item) => (item.type === 'text' ? item.text : item.resource?.data || ''))
          .join('\n\n');
        // Сохраняем результат для истории с LLM
        await this.ai.storeToolResult(sessionId, {
          request: call,
          content: flattened,
          structuredContent: result.structuredContent
        });
      }
      console.log(
        `[Runtime] tools used (${toolsUsed.length}): ${toolsUsed.map((t) => t.name).join(', ')}`
      );
      const reply = await this.ai.simpleChat(
        sessionId,
        'Напиши мне ответ на основе результата выполнения функций, который можно было бы сразу отправить тому, кто запрашивал'
      );
      finalOutput.push(reply);
    } else {
      console.log('[Runtime] tools used (0): no tool calls');
      finalOutput.push(response.message);
    }

    return {
      message: finalOutput.join('\n'),
      tools: toolsUsed
    };
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.ai.resetSession(sessionId);
  }

  /**
   * Режим report: строит отдельный .docx-отчёт с таблицей сумм за указанный период
   * (ввод вида "05/26-08/26"), исходя из актуальной таблицы учёта.
   */
  async generatePeriodReport(periodArg: string): Promise<PeriodReportResult> {
    const period = parsePeriodArg(periodArg);
    // Данные берутся из векторной базы (FalkorDB) — источник правды для ответа.
    // .docx исходной таблицы используется внутри billsPeriodReportService только как
    // шаблон структуры/стилей таблицы, а не источник данных.
    const ledgerRows = await this.ledgerVectorService.getAllRows();
    return billsPeriodReportService.generateReport(
      BILLS_LEDGER_DOCX_PATH,
      ledgerRows,
      period,
      BILLS_REPORT_OUTPUT_DIR
    );
  }

  /**
   * Режим ask: отвечает на вопрос пользователя по таблице учёта коммунальных
   * платежей: выполняет векторный поиск по FalkorDB, формирует контекст из
   * найденных строк и передает его в модель вместе с вопросом.
   */
  async askAboutLedger(sessionId: string, question: string): Promise<string> {
    await this.ensureModePrompt(sessionId, 'ask');

    let contextText: string;
    try {
      const hits = await this.ledgerVectorService.search(question);
      contextText = this.ledgerVectorService.formatSearchContext(hits);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `⛔ Не удалось выполнить поиск по векторной базе данных: ${msg}. Убедитесь, что FalkorDB запущен и таблица уже была актуализирована (команда bills).`;
    }

    const prompt = `Вопрос пользователя: ${question}

Контекст из таблицы учёта коммунальных платежей (самые подходящие строки):
${contextText}

Ответь на вопрос пользователя, используя только этот контекст.`;

    return await this.ai.simpleChat(sessionId, prompt);
  }

  /**
   * ReAct-цикл обработки счетов:
   * 1. Скачивает документы с Яндекс.Диска
   * 2. Отправляет документы на валидацию категорий в RouterAI
   * 3. При успешной валидации — вызывает модель для организации файлов (organize_bills)
   * 4. После ретрай (человек добавил файлы) повторяет цикл
   */
  async runBillsReactCycle(
    sessionId: string,
    _onRetry: () => Promise<void>
  ): Promise<BillValidationResult> {
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
    console.log(`\n🤖 [ReAct] Шаг 2: анализ документов через RouterAI...`);
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

    // Шаг 3: Отправляем документы на валидацию
    let validation: BillValidationResult;
    try {
      validation = await routerAIService.validateBillCategories(filePaths);
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
          { timeout: TOOL_CALL_TIMEOUT_MSEC, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_CALL_MAX_TOTAL_TIMEOUT_MSEC }
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
          BILLS_LEDGER_DOCX_PATH,
          amountsByCategory
        );
        console.log(
          `✅ [ReAct] В таблицу учёта добавлена строка «${appendResult.monthLabel}»: ${BILLS_LEDGER_DOCX_PATH}`
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
        const syncResult = await this.ledgerVectorService.syncLedgerToVectorStore(BILLS_LEDGER_DOCX_PATH);
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
    const result = await this.mcp.callTool(
      {
        name: 'check_bill_receipts',
        arguments: monthDir ? { monthDir } : {}
      },
      CallToolResultSchema,
      { timeout: TOOL_CALL_TIMEOUT_MSEC, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_CALL_MAX_TOTAL_TIMEOUT_MSEC }
    );

    if (result.isError) {
      const text = (result.content as any[])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      throw new Error(text || 'Ошибка проверки квитанций');
    }

    return result.structuredContent as unknown as ReceiptsCheckResult;
  }

  /**
   * Вызывает MCP-инструмент generate_sordisu_bill: создаёт папку текущего месяца
   * в "Сордису по месяцам", копирует туда шаблон и заполняет актуальные даты в счёте.doc,
   * сохраняет результат в pdf и удаляет исходный .doc.
   */
  async generateSordisuBill(): Promise<{
    monthDir: string;
    pdfPath: string;
    spravkaPdfPath?: string;
    spravkaTotalWithVat?: number;
    spravkaWarnings?: string[];
    kommunalkaPdfPath?: string;
    copiedOrganizedDocsCount?: number;
  }> {
    const result = await this.mcp.callTool(
      {
        name: 'generate_sordisu_bill',
        arguments: {}
      },
      CallToolResultSchema,
      { timeout: TOOL_CALL_TIMEOUT_MSEC, resetTimeoutOnProgress: true, maxTotalTimeout: TOOL_CALL_MAX_TOTAL_TIMEOUT_MSEC }
    );

    if (result.isError) {
      const text = (result.content as any[])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      throw new Error(text || 'Ошибка генерации счёта "Сордису"');
    }

    return result.structuredContent as unknown as {
      monthDir: string;
      pdfPath: string;
      spravkaPdfPath?: string;
      spravkaTotalWithVat?: number;
      spravkaWarnings?: string[];
      kommunalkaPdfPath?: string;
      copiedOrganizedDocsCount?: number;
    };
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

  async cleanup() {
    if (this.ollamaProcess) {
      this.ollamaProcess.kill();
      this.ollamaProcess = null;
    }
    try {
      await this.mcp.close();
    } catch (e) {
      // Игнорируем ошибки при закрытии
    }
  }
}

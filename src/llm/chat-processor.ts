import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'node:fs';
import { AIHelperProvider, AIProvider } from './provider-factory.js';
import { AIHelperInterface, ToolDescriptor } from './types.js';
import { getSystemPromptByMode, LlmMode } from './prompts/profiles.js';
import { DocumentsService } from '../services/DocumentsService.js';
import { routerAIService, BillValidationResult } from '../services/RouterAIService.js';
import { BILL_CATEGORY_LABELS, BillCategory } from './prompts/profiles.js';
import { YandexDiskService } from '../services/YandexDiskService.js';

export class ChatProcessor {
  ai: AIHelperInterface;
  private mcp: Client;
  private transport: StdioClientTransport;
  private tools: ToolDescriptor[] = [];
  private ollamaProcess: ChildProcess | null = null;
  private docsService: DocumentsService;
  private yandexDiskService: YandexDiskService;

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

  /**
   * Режим billsWithModel: счета передаются в контекст модели через routerai.
   * PDF отправляются как есть, DOC/XLS конвертируются в PDF через LibreOffice.
   * Модель сама извлекает суммы и считает ИТОГО.
   */
  async processBillsWithModel(
    sessionId: string,
    paths: string[]
  ): Promise<{ message: string; reportPath?: string }> {
    // Получаем список файлов для обработки
    const { files } = await this.docsService.readBillsForModel(paths);
    const filePaths = files.map((f) => f.filePath);

    if (filePaths.length === 0) {
      throw new Error('Не найдено файлов для обработки');
    }

    // Фильтруем дубликаты: если есть "file.doc.pdf" и "file.doc", оставляем только PDF
    const filteredPaths = this.filterConvertedDuplicates(filePaths);

    // Определяем папку для сохранения отчёта (папка со счетами)
    const firstPath = this.docsService.resolveInputPath(paths[0]);
    const outputDir = this.docsService.exists(firstPath) && fs.statSync(firstPath).isDirectory()
      ? firstPath
      : path.dirname(firstPath);

    // Отправляем файлы в routerai (PDF как есть, DOC/XLS конвертируем в PDF)
    const { reply, reportPath } = await routerAIService.processBillsWithFiles(filteredPaths, outputDir);

    return {
      message: reply,
      reportPath
    };
  }

  /**
   * Исключает исходные файлы, если рядом есть их PDF-версии от прошлой конвертации.
   * Например: "счет.doc" + "счет.doc.pdf" → оставляем только "счет.doc.pdf".
   */
  private filterConvertedDuplicates(filePaths: string[]): string[] {
    const pdfSet = new Set(
      filePaths
        .filter((p) => p.toLowerCase().endsWith('.pdf'))
        .map((p) => p.toLowerCase().replace(/\.pdf$/, ''))
    );

    return filePaths.filter((p) => {
      const lower = p.toLowerCase();
      if (lower.endsWith('.pdf')) return true;
      // Если существует PDF-версия этого файла, пропускаем исходник
      return !pdfSet.has(lower + '.pdf');
    });
  }

  /**
   * Создает файл отчета на основе ответа модели.
   */
  private async createBillsReportFromModelResponse(
    inputPaths: string[],
    modelReply: string,
    filePaths: string[]
  ): Promise<string> {
    const now = new Date().toLocaleString('ru-RU');
    const lines: string[] = [
      'Отчёт по счетам (режим billsWithModel)',
      `Дата формирования: ${now}`,
      '',
      'Обработанные документы:',
      ...filePaths.map((p, i) => `  ${i + 1}. ${path.basename(p)}`),
      '',
      'Результат анализа модели:',
      modelReply
    ];

    const firstPath = this.docsService.resolveInputPath(inputPaths[0]);
    const outputDir = this.docsService.exists(firstPath)
      ? path.dirname(firstPath)
      : process.cwd();
    const outputPath = path.join(outputDir, `bills_with_model_report_${Date.now()}.txt`);

    this.docsService.writeFile(outputPath, lines.join('\n'));
    console.log(`  📝 Отчёт сохранён: ${outputPath}`);

    return outputPath;
  }

  // метод для вывода сообщения модели в формате стрима
  async *chatStream(
    sessionId: string,
    text: string,
    mode: LlmMode = 'talk'
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
    mode: LlmMode = 'talk'
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

        const result = await this.mcp.callTool({
          name: call.name,
          arguments: call.arguments
        });

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
            return { filePath: fullPath, category: d.category as string };
          });

        console.log(`  Счета для раскладывания (${bills.length}):`);
        for (const b of bills) {
          console.log(`    • ${path.basename(b.filePath)} → ${b.category}`);
        }

        const organizeResult = await this.mcp.callTool({
          name: 'organize_bills',
          arguments: { bills }
        });

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
    }

    return validation;
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
      for (const d of validation.details) {
        const cat = d.category ? (BILL_CATEGORY_LABELS[d.category] || d.category) : 'не определена';
        const amount = d.hasAmount ? 'сумма есть' : 'СУММА ОТСУТСТВУЕТ';
        const issue = d.issue ? ` | • ${d.issue}` : '';
        lines.push(`  - ${d.file}: [${cat}] ${amount}${issue}`);
      }
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

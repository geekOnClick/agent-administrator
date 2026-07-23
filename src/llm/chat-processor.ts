import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'node:fs';
import { AIHelperProvider, AIProvider } from './provider-factory.js';
import { AIHelperInterface, ToolDescriptor } from './types.js';
import { getSystemPromptByMode, LlmMode } from './prompts/profiles.js';
import { DocumentsService } from '../services/DocumentsService.js';
import { routerAIService } from '../services/RouterAIService.js';

export class ChatProcessor {
  ai: AIHelperInterface;
  private mcp: Client;
  private transport: StdioClientTransport;
  private tools: ToolDescriptor[] = [];
  private ollamaProcess: ChildProcess | null = null;
  private docsService: DocumentsService;

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

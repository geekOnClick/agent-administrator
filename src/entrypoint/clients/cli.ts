import { AiEntryPointInterface } from '../types.js';
import readline from 'readline/promises';
import { ChatProcessor } from '../../llm/chat-processor.js';
import { YandexDiskService } from '../../services/YandexDiskService.js';

export class CliEntryPoint implements AiEntryPointInterface {
  private sessionId: string;
  private readonly yandexDiskService = new YandexDiskService();
  // Состояние ReAct-цикла для bills
  private reactCycleActive = false;

  constructor(private readonly processor: ChatProcessor) {
    this.sessionId = `cli-${Date.now()}`;
  }

  createInterface() {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Вы: '
    });
  }

  /**
   * Одна итерация ReAct-цикла: скачать документы и валидировать.
   */
  private async runBillsReactIteration(): Promise<void> {
    console.log('\n📥 [Цикл] Запуск агентского цикла валидации счетов...');
    process.stdout.write('Агент работает... (1. скачивает документы → 2. передаёт в модель → 3. валидация)\n');

    const validation = await this.processor.runBillsReactCycle(
      this.sessionId,
      async () => {/* placeholder for retry hook */}
    );

    process.stdout.write('\r\x1b[K');
    const report = this.processor.formatValidationReport(validation);
    console.log('\n' + report);

    if (validation.isTokenError) {
      console.log('\n⛔ Недостаточно токенов RouterAI для выполнения запроса.');
      console.log('   Пополните баланс RouterAI и напечатайте retry для повтора.');
    } else if (!validation.valid) {
      console.log('\nℹ️  Добавьте недостающие документы на Яндекс.Диск и напечатайте retry.');
    } else {
      console.log('\n🎉 Все счета по всем категориям получены и валидированы. Цикл завершён.');
      this.reactCycleActive = false;
    }
  }

  async cleanup() {
    console.log('\nЗавершение работы...');
    await this.processor.cleanup();
    process.exit(0);
  }

  async run() {
    console.log(`--- Запуск агента... ---`);
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());

    const rl = this.createInterface();
    try {
      await this.processor.init();
    } catch (error) {
      console.error('Ошибка инициализации:', error);
      process.exit(1);
    }

    console.log(`--- Агент готов ---`);
    console.log('Команды:');
    console.log('  talk <текст> - обычный чат');
    console.log('  bills - обработать счета (документы загружаются с Яндекс.Диска в docs)');
    console.log('  billsWithModel - обработать счета через LLM (документы загружаются с Яндекс.Диска в docs)');
    console.log('  billsReact - запустить ReAct-цикл валидации счетов (скачать + проверить категории)');
    console.log('  retry - повторить цикл после добавления недостающих документов');
    console.log('  exit - выход');

    rl.prompt();

    rl.on('line', async (line: string) => {
      const input = line.trim();

      if (input.toLowerCase() === 'exit') {
        this.cleanup();
      }

      if (!input) {
        rl.prompt();
        return;
      }

      rl.pause();

      try {
        if (input === 'billsReact') {
          this.reactCycleActive = true;
          await this.runBillsReactIteration();
        } else if (input === 'retry') {
          if (!this.reactCycleActive) {
            console.log('⚠️  Нет активного ReAct-цикла. Сначала выполните команду billsReact.');
          } else {
            console.log('🔄 Повторный запуск цикла после добавления документов...');
            await this.runBillsReactIteration();
          }
        } else if (input === 'bills') {
          await this.yandexDiskService.syncDocsToLocal();

          process.stdout.write('Обработка документов...\n');

          const response = await this.processor.processMessage(
            this.sessionId,
            'Рассчитай итоговую сумму по счетам. Пути: docs',
            'bills'
          );
          process.stdout.write('\r\x1b[K');
          console.log(response.message);
        } else if (input === 'billsWithModel') {
          await this.yandexDiskService.syncDocsToLocal();

          process.stdout.write('Модель анализирует документы...\n');

          const filePaths = ['docs'];

          const response = await this.processor.processBillsWithModel(
            this.sessionId,
            filePaths
          );
          process.stdout.write('\r\x1b[K');
          console.log(response.message);
          if (response.reportPath) {
            console.log(`\n📄 Отчёт сохранён: ${response.reportPath}`);
          }
        } else if (input.startsWith('talk ')) {
          const query = input.replace('talk ', '').trim();
          process.stdout.write('Олли: думает...');
          const stream = this.processor.chatStream(this.sessionId, query, 'talk');

          process.stdout.write('\b\b\b\b\b\b\b\b\b');
          process.stdout.write('\x1b[K');

          for await (const part of stream) {
            process.stdout.write(part);
          }
          process.stdout.write('\n');
        }
      } catch (error) {
        console.error('\nОшибка:', error instanceof Error ? error.message : error);
      }

      rl.resume();
      rl.prompt();
    }).on('close', () => {
      this.cleanup();
    });
  }
}

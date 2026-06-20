import { AiEntryPointInterface } from '../types.js';
import readline from 'readline/promises';
import { ChatProcessor } from '../../llm/chat-processor.js';

export class CliEntryPoint implements AiEntryPointInterface {
  private sessionId: string;

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
    console.log(
      '  bills <путь1> [путь2 ...] - обработать счета на оплату (xlsx/xls/pdf) и получить итоговую сумму'
    );
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
        if (input.startsWith('bills ')) {
          const rawPaths = input.replace('bills ', '').trim();
          const filePaths = rawPaths.split(/\s+/).filter(Boolean);
          process.stdout.write(`Обработка ${filePaths.length} счёт(ов)...\n`);

          const response = await this.processor.processMessage(
            this.sessionId,
            `Рассчитай итоговую сумму по счетам с помощью инструмента process_bills. Пути: ${filePaths.join(', ')}`,
            'bills'
          );
          process.stdout.write('\r\x1b[K');
          console.log(response.message);
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

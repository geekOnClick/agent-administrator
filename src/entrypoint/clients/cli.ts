import { AiEntryPointInterface } from '../types.js';
import readline from 'readline/promises';
import { randomUUID } from 'crypto';
import { ChatProcessor } from '../../llm/chat-processor.js';
import { BillsCycleStepResult, SordisuBillResult } from '../../services/BillsCycleService.js';
import { getRouterAIUsageStats } from '../../services/RouterAIService.js';

export class CliEntryPoint implements AiEntryPointInterface {
  private readonly sessionId = `cli-${randomUUID()}`;
  // true, пока обрабатывается команда — защищает от параллельного ввода
  private busy = false;
  // true после запуска завершения — делает cleanup() идемпотентным
  private cleaningUp = false;
  // true, когда readline закрылся во время выполнения команды — cleanup откладывается
  private rlClosed = false;

  constructor(private readonly processor: ChatProcessor) {}

  createInterface() {
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'Вы: '
    });
  }

  /**
   * Печатает результат шага валидации (bills / retry).
   */
  private printValidationStep(result: Extract<BillsCycleStepResult, { kind: 'validation' }>): void {
    const { validation } = result;
    const report = this.processor.billsCycle.formatValidationReport(validation);
    console.log('\n' + report);

    if (validation.isTokenError) {
      console.log('\n⛔ Недостаточно токенов RouterAI для выполнения запроса.');
      console.log('   Пополните баланс RouterAI и напечатайте retry для повтора.');
    } else if (!validation.valid) {
      console.log('\nℹ️  Добавьте недостающие документы на Яндекс.Диск и напечатайте retry.');
    } else {
      console.log('\n🎉 Все счета по всем категориям получены и валидированы, счета разложены по папкам.');
      console.log('\n💳 Пришло время оплатить счета. Оплатите счета, сохраните квитанции/чеки в соответствующие папки');
      console.log('   и напечатайте "continue" для возобновления цикла и проверки оплаты.');
    }
  }

  private printSordisuResult(result: SordisuBillResult): void {
    console.log(`✅ Счёт сгенерирован: ${result.pdfPath}`);
    if (result.spravkaPdfPath) {
      console.log(`✅ Справка-расчёт сгенерирована: ${result.spravkaPdfPath}`);
    }
    if (typeof result.spravkaTotalWithVat === 'number') {
      console.log(`   Итого: ${result.spravkaTotalWithVat.toFixed(2)} руб.`);
    }
    if (result.spravkaWarnings && result.spravkaWarnings.length > 0) {
      console.log('   ⚠️ Предупреждения:');
      for (const w of result.spravkaWarnings) {
        console.log(`     - ${w}`);
      }
    }
    if (result.kommunalkaPdfPath) {
      console.log(`✅ Счёт-коммуналка сгенерирована: ${result.kommunalkaPdfPath}`);
    }
    if (typeof result.copiedOrganizedDocsCount === 'number') {
      console.log(`✅ В папку со счётами скопировано счётов/квитанций: ${result.copiedOrganizedDocsCount}`);
    }
  }

  private async handleBillsStart(): Promise<void> {
    console.log('\n📥 [Цикл] Запуск агентского цикла валидации счетов...');
    console.log('Агент работает... (1. скачивает документы → 2. передаёт в модель → 3. валидация)');
    const result = await this.processor.billsCycle.startBillsCycle();
    if (result.kind === 'validation') {
      this.printValidationStep(result);
    }
  }

  private async handleBillsRetry(): Promise<void> {
    try {
      console.log('🔄 Повторный запуск цикла после добавления документов...');
      const result = await this.processor.billsCycle.retryBillsCycle();
      if (result.kind === 'validation') {
        this.printValidationStep(result);
      }
    } catch (err) {
      console.log(`⚠️  ${err instanceof Error ? err.message : err}`);
    }
  }

  private async handleBillsContinue(force: boolean): Promise<void> {
    if (this.processor.billsCycle.getBillsCyclePhase() !== 'awaitingPayment') {
      console.log(`⚠️  Цикл не приостановлен на ожидании оплаты. Команда ${force ? 'continue!' : 'continue'} сейчас не нужна.`);
      return;
    }

    console.log(
      force
        ? '💳 Продолжаю цикл принудительно: проверяю квитанции об оплате (папки без чека будут исключены из счёта)...'
        : '💳 Продолжаю цикл: проверяю квитанции об оплате...'
    );
    console.log('\n🔍 [Цикл] Проверяю квитанции об оплате в каждой папке...');

    try {
      const result = await this.processor.billsCycle.continueBillsCycle(force);

      if (result.kind === 'receiptsFailed') {
        console.log('\n' + this.processor.billsCycle.formatReceiptsCheckReport(result.receipts));
        console.log(`\n⛔ [Ошибка] Не хватает квитанций в ${result.failed.length} папке(ах):`);
        for (const f of result.failed) {
          console.log(`   • ${f.category} (📁 ${f.dir}) — ${f.issue}`);
        }
        console.log('   Добавьте/исправьте квитанции в указанных выше папках и напечатайте "continue" снова.');
        console.log('   Либо напечатайте "continue!", чтобы продолжить без этих ресурсов — итоговый счёт "Сордису" будет сформирован без их указания.');
        return;
      }

      // sordisuGenerated
      if (result.kind !== 'sordisuGenerated') return; // для сужения типа
      console.log('\n' + this.processor.billsCycle.formatReceiptsCheckReport(result.receipts));
      if (result.excludedCategories.length > 0) {
        console.log(
          `\n⚠️ Форсированное продолжение (continue!): категории без квитанции исключены из счёта "Сордису": ${result.excludedCategories.join(', ')}`
        );
        console.log('\n🧾 [Цикл] Счёт аренды "Сордису" за текущий месяц (без исключённых ресурсов):');
      } else {
        console.log('\n🎉 Все квитанции найдены.');
        console.log('\n🧾 [Цикл] Счёт аренды "Сордису" за текущий месяц:');
      }
      this.printSordisuResult(result.sordisu);
      console.log('\n🏁 Агентский цикл завершён.');
      await this.cleanup();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n⛔ [Ошибка]: ${msg}`);
      console.log('   Напечатайте "continue" для повторной попытки.');
    }
  }

  /** Печатает накопленную стоимость облачных вызовов RouterAI (метрика стоимости). */
  private printRouterAICostSummary(): void {
    const stats = getRouterAIUsageStats();
    if (stats.requests === 0) return;
    console.log(
      `\n💰 Стоимость облачных запросов RouterAI за сессию: ${stats.costRub.toFixed(4)} руб. ` +
        `(запросов: ${stats.requests}, токены: ${stats.promptTokens} вх. / ${stats.completionTokens} вых.)`
    );
  }

  async cleanup() {
    if (this.cleaningUp) return;
    this.cleaningUp = true;
    console.log('\nЗавершение работы...');
    this.printRouterAICostSummary();
    try {
      await this.processor.cleanup();
    } catch (err) {
      console.error('Ошибка при завершении:', err instanceof Error ? err.message : err);
    } finally {
      process.exit(0);
    }
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
    console.log('  ask <вопрос> - вопрос по содержимому таблицы учёта (векторная база данных)');
    console.log('  meters el-00000,vod-00000 - внести показания счётчиков электроэнергии и водоканала (текущей датой)');
    console.log('  askMeters <вопрос> - вопрос по таблицам показаний счётчиков (векторная база данных)');
    console.log('  report MM/YY-MM/YY - сформировать .docx-отчёт по суммам за указанный период (например: report 05/26-08/26)');
    console.log('  bills - запустить ReAct-цикл валидации счетов (скачать + проверить категории)');
    console.log('  retry - повторить цикл после добавления недостающих документов');
    console.log('  continue - возобновить цикл после оплаты счетов и проверить квитанции');
    console.log('  stopTg - (только через Telegram-бот) принудительно остановить бота и выгрузить локальную модель Ollama');
    console.log('  exit - выход');

    rl.prompt();

    rl.on('line', (line: string) => {
      const input = line.trim();

      if (this.busy) {
        if (input) {
          console.log('⏳ Агент занят выполнением предыдущей команды, дождитесь её завершения.');
        }
        return;
      }

      if (!input) {
        rl.prompt();
        return;
      }

      const normalizedInput = input.toLowerCase();
      if (normalizedInput === 'exit') {
        void this.cleanup();
        return;
      }
      if (normalizedInput === 'stoptg') {
        console.log('⚠️  stopTg доступна только при запуске через Telegram-бота. Здесь используйте «exit».');
        rl.prompt();
        return;
      }

      this.busy = true;
      this.handleCommand(input)
        .catch((error) => {
          console.error('\nОшибка:', error instanceof Error ? error.message : error);
        })
        .finally(() => {
          this.busy = false;
          if (this.rlClosed && !this.cleaningUp) {
            void this.cleanup();
            return;
          }
          if (!this.cleaningUp) {
            rl.prompt();
          }
        });
    }).on('close', () => {
      this.rlClosed = true;
      if (!this.busy) {
        void this.cleanup();
      }
    });
  }

  private async handleCommand(input: string): Promise<void> {
    const command = input.toLowerCase();

    if (command === 'continue' || command === 'continue!') {
      await this.handleBillsContinue(command === 'continue!');
    } else if (command === 'bills') {
      await this.handleBillsStart();
    } else if (command === 'retry') {
      await this.handleBillsRetry();
    } else if (input.startsWith('askMeters ')) {
      const question = input.slice('askMeters '.length).trim();
      if (!question) {
        console.log('⚠️  Укажите вопрос после команды: askMeters <ваш вопрос>');
      } else {
        process.stdout.write('🔍 ищу ответ в векторной базе данных по показаниям счётчиков...\n');
        const answer = await this.processor.askAboutMeters(this.sessionId, question);
        console.log(answer);
      }
    } else if (input.startsWith('ask ')) {
      const question = input.slice('ask '.length).trim();
      if (!question) {
        console.log('⚠️  Укажите вопрос после команды: ask <ваш вопрос>');
      } else {
        process.stdout.write('🔍 ищу ответ в векторной базе данных...\n');
        const answer = await this.processor.askAboutLedger(this.sessionId, question);
        console.log(answer);
      }
    } else if (input.startsWith('meters ')) {
      const metersArg = input.slice('meters '.length).trim();
      const parsed = this.processor.parseMetersInput(metersArg);
      if (!parsed) {
        console.log('⛔ Некорректный формат. Ожидается: meters el-00000,vod-00000 (например: meters el-02345,vod-00317)');
      } else {
        try {
          process.stdout.write('📊 вношу показания счётчиков и актуализирую векторную базу...\n');
          const result = await this.processor.recordMeterReadings(parsed.electricity, parsed.water);
          console.log(
            `✅ Добавлены строки: электроэнергия [${result.electricity.dateLabel} | ${result.electricity.value}], водоканал [${result.water.dateLabel} | ${result.water.value}]. векторная база обновлена, строк проиндексировано: ${result.rowsIndexed}`
          );
        } catch (err) {
          console.error(`⛔ Не удалось внести показания счётчиков: ${err instanceof Error ? err.message : err}`);
        }
      }
    } else if (input.startsWith('report ')) {
      const periodArg = input.slice('report '.length).trim();
      if (!periodArg) {
        console.log('⚠️  Укажите период после команды: report MM/YY-MM/YY (например: report 05/26-08/26)');
      } else {
        try {
          process.stdout.write('📊 формирую отчёт за период...\n');
          const result = await this.processor.generatePeriodReport(periodArg);
          console.log(`✅ Отчёт сформирован (${result.rowsIncluded} строк(и)): ${result.reportPath}`);
        } catch (err) {
          console.error(`⛔ Не удалось сформировать отчёт: ${err instanceof Error ? err.message : err}`);
        }
      }
    } else {
      console.log(`⚠️  Неизвестная команда: ${input}. Список команд выводится при запуске агента.`);
    }
  }
}
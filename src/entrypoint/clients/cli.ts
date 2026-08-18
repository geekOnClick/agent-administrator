import { AiEntryPointInterface } from '../types.js';
import readline from 'readline/promises';
import { ChatProcessor } from '../../llm/chat-processor.js';

export class CliEntryPoint implements AiEntryPointInterface {
  private sessionId: string;
  // Состояние ReAct-цикла для bills
  private reactCycleActive = false;
  // true, когда цикл приостановлен и ждёт "continue" от пользователя перед проверкой квитанций
  private awaitingPaymentContinue = false;

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
      console.log('\n🎉 Все счета по всем категориям получены и валидированы, счета разложены по папкам.');
      console.log('\n💳 Пришло время оплатить счета. Оплатите счета, сохраните квитанции/чеки в соответствующие папки');
      console.log('   и напечатайте "continue" для возобновления цикла и проверки оплаты.');
      this.awaitingPaymentContinue = true;
    }
  }

  /**
   * Завершающая часть ReAct-цикла: после оплаты (команда "continue")
   * вызывает check_bill_receipts и сверяет, что в каждой папке есть подтверждающая квитанция.
   * Выбор модели (локальная gemma / RouterAI) осуществляет встроенный роутер сложности.
   * Генерирует вызов снова, если в какой-то из папок квитанция не найдена/не совиадает по сумме.
   */
  private async runReceiptsCheckAfterPayment(): Promise<void> {
    console.log('\n🔍 [Цикл] Проверяю квитанции об оплате в каждой папке...');

    try {
      const result = await this.processor.checkBillReceipts();
      const report = this.processor.formatReceiptsCheckReport(result);
      console.log('\n' + report);

      if (result.ok) {
        console.log('\n🎉 Все квитанции найдены.');
        this.awaitingPaymentContinue = false;
        this.reactCycleActive = false;

        console.log('\n🧾 [Цикл] генерирую счёт аренды \"Сордису\" за текущий месяц...');
        try {
          const sordisuResult = await this.processor.generateSordisuBill();
          console.log(`✅ Счёт сгенерирован: ${sordisuResult.pdfPath}`);
          if (sordisuResult.spravkaPdfPath) {
            console.log(`✅ Справка-расчёт сгенерирована: ${sordisuResult.spravkaPdfPath}`);
          }
          if (typeof sordisuResult.spravkaTotalWithVat === 'number') {
            console.log(`   Итого: ${sordisuResult.spravkaTotalWithVat.toFixed(2)} руб.`);
          }
          if (sordisuResult.spravkaWarnings && sordisuResult.spravkaWarnings.length > 0) {
            console.log('   ⚠️ Предупреждения:');
            for (const w of sordisuResult.spravkaWarnings) {
              console.log(`     - ${w}`);
            }
          }
          if (sordisuResult.kommunalkaPdfPath) {
            console.log(`✅ Счёт-коммуналка сгенерирована: ${sordisuResult.kommunalkaPdfPath}`);
          }
          if (typeof sordisuResult.copiedOrganizedDocsCount === 'number') {
            console.log(`✅ В папку со счётами скопировано счётов/квитанций: ${sordisuResult.copiedOrganizedDocsCount}`);
          }

          console.log('\n🏁 Агентский цикл завершён.');
          this.cleanup();
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`⛔ [Ошибка] генерации счёта "Сордису": ${msg}`);
        }
      } else {
        const failed = this.processor.getFailedReceiptFolders(result);
        console.log(`\n⛔ [Ошибка] Не хватает квитанций в ${failed.length} папке(ах):`);
        for (const f of failed) {
          console.log(`   • ${f.category} (📁 ${f.dir}) — ${f.issue}`);
        }
        console.log('   Добавьте/исправьте квитанции в указанных выше папках и напечатайте "continue" снова.');
        this.awaitingPaymentContinue = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n⛔ [Ошибка] проверки квитанций: ${msg}`);
      console.log('   Напечатайте "continue" для повторной попытки.');
      this.awaitingPaymentContinue = true;
    }
  }

  async cleanup() {
    console.log('\nЗавершение работы...');
    await this.processor.cleanup();
    // Если процесс запущен через nodemon (npm run start), сам nodemon не завершается
    // при штатном (код 0) выходе дочернего процесса — он просто ждёт изменений файлов.
    // Поэтому явно посылаем SIGTERM родительскому процессу-монитору, чтобы завершить
    // весь скрипт целиком, а не только текущий процесс.
    if (process.ppid) {
      try {
        process.kill(process.ppid, 'SIGTERM');
      } catch {
        // ignore: родительский процесс может отсутствовать/уже завершиться
      }
    }
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
    console.log('  ask <вопрос> - вопрос по содержимому таблицы учёта (векторная база данных)');
    console.log('  report MM/YY-MM/YY - сформировать .docx-отчёт по суммам за указанный период (например: report 05/26-08/26)');
    console.log('  bills - запустить ReAct-цикл валидации счетов (скачать + проверить категории)');
    console.log('  retry - повторить цикл после добавления недостающих документов');
    console.log('  continue - возобновить цикл после оплаты счетов и проверить квитанции');
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
        if (input.toLowerCase() === 'continue') {
          if (!this.awaitingPaymentContinue) {
            console.log('⚠️  Цикл не приостановлен на ожидании оплаты. Команда continue сейчас не нужна.');
          } else {
            console.log('💳 Продолжаю цикл: проверяю квитанции об оплате...');
            await this.runReceiptsCheckAfterPayment();
          }
        } else if (input === 'bills') {
          this.reactCycleActive = true;
          this.awaitingPaymentContinue = false;
          await this.runBillsReactIteration();
        } else if (input === 'retry') {
          if (!this.reactCycleActive) {
            console.log('⚠️  Нет активного ReAct-цикла. Сначала выполните команду bills.');
          } else if (this.awaitingPaymentContinue) {
            console.log('⚠️  Цикл ожидает оплаты. Напечатайте continue после оплаты счетов.');
          } else {
            console.log('🔄 Повторный запуск цикла после добавления документов...');
            await this.runBillsReactIteration();
          }
        } else if (input.startsWith('ask ')) {
          const question = input.replace('ask ', '').trim();
          if (!question) {
            console.log('⚠️  Укажите вопрос после команды: ask <ваш вопрос>');
          } else {
            process.stdout.write('🔍 ищу ответ в векторной базе данных...\n');
            const answer = await this.processor.askAboutLedger(this.sessionId, question);
            console.log(answer);
          }
        } else if (input.startsWith('report ')) {
          const periodArg = input.replace(/^report\s+/, '').trim();
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

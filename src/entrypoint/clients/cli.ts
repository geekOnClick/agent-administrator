import { AiEntryPointInterface } from '../types.js';
import readline from 'readline/promises';
import { ChatProcessor } from '../../llm/chat-processor.js';
import { YandexDiskService } from '../../services/YandexDiskService.js';

export class CliEntryPoint implements AiEntryPointInterface {
  private sessionId: string;
  private readonly yandexDiskService = new YandexDiskService();
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
      console.log('\n\u26d4 \u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u0442\u043e\u043a\u0435\u043d\u043e\u0432 RouterAI \u0434\u043b\u044f \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u044f \u0437\u0430\u043f\u0440\u043e\u0441\u0430.');
      console.log('   \u041f\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435 \u0431\u0430\u043b\u0430\u043d\u0441 RouterAI \u0438 \u043d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439\u0442\u0435 retry \u0434\u043b\u044f \u043f\u043e\u0432\u0442\u043e\u0440\u0430.');
    } else if (!validation.valid) {
      console.log('\n\u2139\ufe0f  \u0414\u043e\u0431\u0430\u0432\u044c\u0442\u0435 \u043d\u0435\u0434\u043e\u0441\u0442\u0430\u044e\u0449\u0438\u0435 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u044b \u043d\u0430 \u042f\u043d\u0434\u0435\u043a\u0441.\u0414\u0438\u0441\u043a \u0438 \u043d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439\u0442\u0435 retry.');
    } else {
      console.log('\n\ud83c\udf89 \u0412\u0441\u0435 \u0441\u0447\u0435\u0442\u0430 \u043f\u043e \u0432\u0441\u0435\u043c \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f\u043c \u043f\u043e\u043b\u0443\u0447\u0435\u043d\u044b \u0438 \u0432\u0430\u043b\u0438\u0434\u0438\u0440\u043e\u0432\u0430\u043d\u044b, \u0441\u0447\u0435\u0442\u0430 \u0440\u0430\u0437\u043b\u043e\u0436\u0435\u043d\u044b \u043f\u043e \u043f\u0430\u043f\u043a\u0430\u043c.');
      console.log('\n\ud83d\udcb3 \u041f\u0440\u0438\u0448\u043b\u043e \u0432\u0440\u0435\u043c\u044f \u043e\u043f\u043b\u0430\u0442\u0438\u0442\u044c \u0441\u0447\u0435\u0442\u0430. \u041e\u043f\u043b\u0430\u0442\u0438\u0442\u0435 \u0441\u0447\u0435\u0442\u0430, \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u0435 \u043a\u0432\u0438\u0442\u0430\u043d\u0446\u0438\u0438/\u0447\u0435\u043a\u0438 \u0432 \u0441\u043e\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0435 \u043f\u0430\u043f\u043a\u0438');
      console.log('   \u0438 \u043d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439\u0442\u0435 "continue" \u0434\u043b\u044f \u0432\u043e\u0437\u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f \u0446\u0438\u043a\u043b\u0430 \u0438 \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438 \u043e\u043f\u043b\u0430\u0442\u044b.');
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
    console.log('\n\ud83d\udd0d [\u0421\u0438\u043a\u043b] \u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e \u043a\u0432\u0438\u0442\u0430\u043d\u0446\u0438\u0438 \u043e\u0431 \u043e\u043f\u043b\u0430\u0442\u0435 \u0432 \u043a\u0430\u0436\u0434\u043e\u0439 \u043f\u0430\u043f\u043a\u0435...');

    try {
      const result = await this.processor.checkBillReceipts();
      const report = this.processor.formatReceiptsCheckReport(result);
      console.log('\n' + report);

      if (result.ok) {
        console.log('\n\ud83c\udf89 \u0412\u0441\u0435 \u043a\u0432\u0438\u0442\u0430\u043d\u0446\u0438\u0438 \u043d\u0430\u0439\u0434\u0435\u043d\u044b \u0438 \u0441\u0443\u043c\u043c\u044b \u0441\u043e\u0432\u043f\u0430\u0434\u0430\u044e\u0442. \u0426\u0438\u043a\u043b \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d.');
        this.awaitingPaymentContinue = false;
        this.reactCycleActive = false;

        console.log('\n\ud83e\uddfe [\u0421\u0438\u043a\u043b] \u0433\u0435\u043d\u0435\u0440\u0438\u0440\u0443\u044e \u0441\u0447\u0451\u0442 \u0430\u0440\u0435\u043d\u0434\u044b \"\u0421\u043e\u0440\u0434\u0438\u0441\u0443\" \u0437\u0430 \u0442\u0435\u043a\u0443\u0449\u0438\u0439 \u043c\u0435\u0441\u044f\u0446...');
        try {
          const sordisuResult = await this.processor.generateSordisuBill();
          console.log(`\u2705 \u0421\u0447\u0451\u0442 \u0441\u0433\u0435\u043d\u0435\u0440\u0438\u0440\u043e\u0432\u0430\u043d: ${sordisuResult.pdfPath}`);
          if (sordisuResult.spravkaPdfPath) {
            console.log(`\u2705 \u0421\u043f\u0440\u0430\u0432\u043a\u0430-\u0440\u0430\u0441\u0447\u0451\u0442 \u0441\u0433\u0435\u043d\u0435\u0440\u0438\u0440\u043e\u0432\u0430\u043d\u0430: ${sordisuResult.spravkaPdfPath}`);
          }
          if (typeof sordisuResult.spravkaTotalWithVat === 'number') {
            console.log(`   \u0418\u0442\u043e\u0433\u043e: ${sordisuResult.spravkaTotalWithVat.toFixed(2)} \u0440\u0443\u0431.`);
          }
          if (sordisuResult.spravkaWarnings && sordisuResult.spravkaWarnings.length > 0) {
            console.log('   ⚠️ Предупреждения:');
            for (const w of sordisuResult.spravkaWarnings) {
              console.log(`     - ${w}`);
            }
          }
          if (sordisuResult.kommunalkaPdfPath) {
            console.log(`\u2705 \u0421\u0447\u0451\u0442-\u043a\u043e\u043c\u043c\u0443\u043d\u0430\u043b\u043a\u0430 \u0441\u0433\u0435\u043d\u0435\u0440\u0438\u0440\u043e\u0432\u0430\u043d\u0430: ${sordisuResult.kommunalkaPdfPath}`);
          }
          if (typeof sordisuResult.copiedOrganizedDocsCount === 'number') {
            console.log(`\u2705 \u0412 \u043f\u0430\u043f\u043a\u0443 \u0441\u043e \u0441\u0447\u0451\u0442\u0430\u043c\u0438 \u0441\u043a\u043e\u043f\u0438\u0440\u043e\u0432\u0430\u043d\u043e \u0441\u0447\u0451\u0442\u043e\u0432/\u043a\u0432\u0438\u0442\u0430\u043d\u0446\u0438\u0439: ${sordisuResult.copiedOrganizedDocsCount}`);
          }

          console.log('\n\ud83c\udfc1 \u0410\u0433\u0435\u043d\u0442\u0441\u043a\u0438\u0439 \u0446\u0438\u043a\u043b \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d.');
          this.cleanup();
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\u26d4 [\u041e\u0448\u0438\u0431\u043a\u0430] \u0433\u0435\u043d\u0435\u0440\u0430\u0446\u0438\u0438 \u0441\u0447\u0451\u0442\u0430 "\u0421\u043e\u0440\u0434\u0438\u0441\u0443": ${msg}`);
        }
      } else {
        const failed = this.processor.getFailedReceiptFolders(result);
        console.log(`\n\u26d4 [\u041e\u0448\u0438\u0431\u043a\u0430] \u041d\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u043a\u0432\u0438\u0442\u0430\u043d\u0446\u0438\u0439 \u0432 ${failed.length} \u043f\u0430\u043f\u043a\u0435(\u0430\u0445):`);
        for (const f of failed) {
          console.log(`   \u2022 ${f.category} (\ud83d\udcc1 ${f.dir}) \u2014 ${f.issue}`);
        }
        console.log('   \u0414\u043e\u0431\u0430\u0432\u044c\u0442\u0435/\u0438\u0441\u043f\u0440\u0430\u0432\u044c\u0442\u0435 \u043a\u0432\u0438\u0442\u0430\u043d\u0446\u0438\u0438 \u0432 \u0443\u043a\u0430\u0437\u0430\u043d\u043d\u044b\u0445 \u0432\u044b\u0448\u0435 \u043f\u0430\u043f\u043a\u0430\u0445 \u0438 \u043d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439\u0442\u0435 "continue" \u0441\u043d\u043e\u0432\u0430.');
        this.awaitingPaymentContinue = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n\u26d4 [\u041e\u0448\u0438\u0431\u043a\u0430] \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438 \u043a\u0432\u0438\u0442\u0430\u043d\u0446\u0438\u0439: ${msg}`);
      console.log('   \u041d\u0430\u043f\u0435\u0447\u0430\u0442\u0430\u0439\u0442\u0435 "continue" \u0434\u043b\u044f \u043f\u043e\u0432\u0442\u043e\u0440\u043d\u043e\u0439 \u043f\u043e\u043f\u044b\u0442\u043a\u0438.');
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
    console.log('  bills - обработать счета (документы загружаются с Яндекс.Диска в docs)');
    console.log('  billsWithModel - обработать счета через LLM (документы загружаются с Яндекс.Диска в docs)');
    console.log('  billsReact - запустить ReAct-цикл валидации счетов (скачать + проверить категории)');
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
        } else if (input === 'billsReact') {
          this.reactCycleActive = true;
          this.awaitingPaymentContinue = false;
          await this.runBillsReactIteration();
        } else if (input === 'retry') {
          if (!this.reactCycleActive) {
            console.log('⚠️  Нет активного ReAct-цикла. Сначала выполните команду billsReact.');
          } else if (this.awaitingPaymentContinue) {
            console.log('⚠️  Цикл ожидает оплаты. Напечатайте continue после оплаты счетов.');
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

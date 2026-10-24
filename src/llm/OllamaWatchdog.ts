import { execSync, spawnSync } from 'node:child_process';

/**
 * Аварийная остановка зависшей локальной модели Ollama.
 *
 * Если запрос к Ollama не завершается за OLLAMA_REQUEST_TIMEOUT_MS (по умолчанию
 * 120 секунд), watchdog:
 *   1. Отменяет запрос через AbortController.
 *   2. Пытается мягко выгрузить модель через API (keep_alive=0).
 *   3. Если мягкая выгрузка не помогает — убивает процесс `ollama` через `pkill`.
 *
 * Использование:
 *   const result = await OllamaWatchdog.run(
 *     () => client.chat({ ... }),
 *     { model: 'gemma4:e4b-8k', timeoutMs: 120_000 }
 *   );
 */
export class OllamaWatchdog {
  /**
   * Запускает fn с жёстким дедлайном. При срабатывании:
   *   - fn отменяется через переданный AbortSignal (если fn его поддерживает) — см. overload ниже.
   *   - выполняется аварийная остановка Ollama.
   *   - бросает OllamaTimeoutError.
   *
   * @param fn      Функция-обёртка: принимает AbortSignal и возвращает промис.
   * @param options timeoutMs — дедлайн (мс); model — имя модели для выгрузки;
   *                ollamaHost — базовый URL Ollama API; killProcess — убивать ли процесс при зависании.
   */
  static async run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options: {
      timeoutMs: number;
      model: string;
      ollamaHost?: string;
      killProcess?: boolean;
    }
  ): Promise<T> {
    const { timeoutMs, model, ollamaHost = 'http://localhost:11434', killProcess = true } = options;

    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new OllamaTimeoutError(model, timeoutMs));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([fn(ac.signal), timeoutPromise]);
      return result;
    } catch (err) {
      if (err instanceof OllamaTimeoutError) {
        console.error(
          `\n⛔ [OllamaWatchdog] Модель "${model}" зависла (таймаут ${timeoutMs / 1000} с). ` +
          `Запускаю аварийную остановку...`
        );
        await OllamaWatchdog.emergencyStop(model, ollamaHost, killProcess);
        throw err;
      }
      throw err;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Аварийная остановка: сначала мягкая выгрузка через API, затем pkill ollama.
   * Оба шага best-effort — ошибки глушатся, чтобы не маскировать исходный OllamaTimeoutError.
   */
  static async emergencyStop(
    model: string,
    ollamaHost: string = 'http://localhost:11434',
    killProcess: boolean = true
  ): Promise<void> {
    // Шаг 1: Мягкая выгрузка через Ollama REST API (keep_alive=0)
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5_000);
      await fetch(`${ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
        signal: ac.signal
      });
      clearTimeout(timer);
      console.warn(`[OllamaWatchdog] Мягкая выгрузка модели "${model}" выполнена.`);
    } catch {
      console.warn(`[OllamaWatchdog] Мягкая выгрузка модели "${model}" не удалась — процесс будет убит.`);
    }

    if (!killProcess) return;

    // Шаг 2: Убиваем процесс ollama
    try {
      // Сначала пробуем SIGTERM (корректная остановка)
      const termResult = spawnSync('pkill', ['-TERM', '-x', 'ollama'], { timeout: 3_000 });
      if (termResult.status === 0) {
        console.warn(`[OllamaWatchdog] Процесс ollama остановлен (SIGTERM).`);
        // Даём секунду на корректное завершение
        await new Promise((r) => setTimeout(r, 1_000));
      }

      // Проверяем, ещё жив ли процесс
      const checkResult = spawnSync('pgrep', ['-x', 'ollama'], { timeout: 2_000 });
      if (checkResult.status === 0) {
        // Процесс ещё жив — добиваем SIGKILL
        spawnSync('pkill', ['-KILL', '-x', 'ollama'], { timeout: 3_000 });
        console.warn(`[OllamaWatchdog] Процесс ollama принудительно завершён (SIGKILL).`);
      }
    } catch (killErr) {
      // Если pkill не найден (Windows / нестандартная ОС) — пробуем через kill PID
      try {
        const pidRaw = execSync('pgrep -x ollama', { encoding: 'utf-8', timeout: 2_000 }).trim();
        const pid = Number(pidRaw.split('\n')[0]);
        if (pid > 0) {
          process.kill(pid, 'SIGKILL');
          console.warn(`[OllamaWatchdog] Процесс ollama (PID ${pid}) убит через process.kill.`);
        }
      } catch {
        console.error(
          `[OllamaWatchdog] Не удалось убить процесс ollama:`,
          killErr instanceof Error ? killErr.message : killErr
        );
      }
    }
  }
}

/**
 * Ошибка, которую выбрасывает OllamaWatchdog при срабатывании таймаута.
 * Имеет флаг isOllamaTimeout === true для фильтрации в обработчиках.
 */
export class OllamaTimeoutError extends Error {
  readonly isOllamaTimeout = true;

  constructor(model: string, timeoutMs: number) {
    super(
      `Ollama зависла: модель "${model}" не ответила за ${timeoutMs / 1000} с. ` +
      `Процесс ollama принудительно остановлен. Перезапустите ollama и повторите команду.`
    );
    this.name = 'OllamaTimeoutError';
  }
}

import { spawn, ChildProcess } from 'child_process';
import { Telegraf, Context } from 'telegraf';
import { AiEntryPointInterface } from '../types.js';
import { config } from '../../config.js';

// Максимальная длина сообщения Telegram.
const TG_MAX = 4000;
// Дебаунс накопления stdout перед отправкой, мс.
const FLUSH_MS = 300;

// Паттерны баннеров npm/nodemon, которые не нужно пересылать в чат.
const NOISE_PATTERNS: RegExp[] = [
  /^\[nodemon\]/,
  /^npm (warn|ERR!|notice)/i,
  /^> /
];

// Строки stderr (варнинги Node.js и прочий шум), которые не показываем пользователю.
// Важно: под PTY stderr сливается в stdout, поэтому фильтр применяется к обоим потокам.
const STDERR_NOISE_PATTERNS: RegExp[] = [
  /DeprecationWarning/i,
  /--trace-deprecation/,
  /ExperimentalWarning/i
];

// Эмодзи для строк справки по командам (как в консольном приветствии cli.ts).
const COMMAND_EMOJI: Record<string, string> = {
  'ask <вопрос>': '\u{1F4AC}',
  'meters el-00000,vod-00000': '\u{1F4A1}',
  'askMeters <вопрос>': '\u{1F4CA}',
  'report MM/YY-MM/YY': '\u{1F4C4}',
  bills: '\u{1F9FE}',
  retry: '\u{1F504}',
  continue: '\u{25B6}\u{FE0F}',
  exit: '\u{1F6AA}'
};

// Режимы разбора stdout.
type ParseMode = 'plain' | 'cmdHead' | 'cmdRows';

interface ChatState {
  child: ChildProcess | null;
  buf: string[];
  timer: ReturnType<typeof setTimeout> | null;
  lastErr: string | null;
  // Незавершённая строка stdout (кусок без \n от прошлого data-события).
  partial: string;
  // Последняя команда, отправленная в stdin — нужна для фильтрации эха PTY.
  lastInput: string;
  // Состояние парсера блока «Команды:» — блок может прийти по строкам
  // в разных data-событиях, поэтому режим хранится между вызовами.
  mode: ParseMode;
  // Накопленные строки справки для HTML-сообщения.
  cmdRows: string[];
  // Строки, пришедшие до заголовка «Команды:» в том же data-событии.
  preCmd: string[];
}

// Срезает все управляющие ANSI-последовательности (CSI, OSC, одиночные ESC),
// CR, BS, колокол и прочие непечатные символы; схлопывает пробелы по краям.
function stripControl(raw: string): string {
  return raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI: цвета, курсор, режимы
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC: заголовок окна и т.п.
    .replace(/\x1b[@-Z\\-_]/g, '') // прочие ESC-последовательности
    .replace(/\r/g, '')
    .replace(/\x08.?/g, '') // backspace вместе со стираемым символом
    .replace(/[\x00-\x06\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, '')
    .replace(/[ \t]+$/g, '');
}

// Экранирование для parse_mode HTML.
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class TelegramEntryPoint implements AiEntryPointInterface {
  private readonly bot: Telegraf;
  private readonly allowed: Set<number>;
  private readonly sessions = new Map<number, ChatState>();

  constructor() {
    if (!config.telegram.botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
    }
    this.bot = new Telegraf(config.telegram.botToken);
    this.allowed = new Set(config.telegram.allowedChatIds);
  }

  private getState(chatId: number): ChatState {
    let s = this.sessions.get(chatId);
    if (!s) {
      s = {
        child: null,
        buf: [],
        timer: null,
        lastErr: null,
        partial: '',
        lastInput: '',
        mode: 'plain',
        cmdRows: [],
        preCmd: []
      };
      this.sessions.set(chatId, s);
    }
    return s;
  }

  private isAllowed(ctx: Context): boolean {
    if (this.allowed.size === 0) return true;
    const id = ctx.chat?.id;
    return typeof id === 'number' && this.allowed.has(id);
  }

  private isNoise(line: string): boolean {
    return NOISE_PATTERNS.some((p) => p.test(line));
  }

  private flush(chatId: number): void {
    const s = this.getState(chatId);
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const lines = s.buf.splice(0, s.buf.length);
    if (lines.length === 0) return;

    const text = lines.join('\n');
    // Разбиваем на части по границам строк, не превышая лимит.
    for (const chunk of this.chunkText(text)) {
      this.bot.telegram.sendMessage(chatId, chunk).catch((e) => {
        console.error(`[telegram] sendMessage to ${chatId} failed:`, e);
      });
    }
  }

  private chunkText(text: string): string[] {
    const chunks: string[] = [];
    while (text.length > 0) {
      let chunk = text.slice(0, TG_MAX);
      if (text.length > TG_MAX) {
        const nl = chunk.lastIndexOf('\n');
        if (nl > 0) chunk = chunk.slice(0, nl);
      }
      text = text.slice(chunk.length);
      if (text.startsWith('\n')) text = text.slice(1);
      if (chunk.trim().length > 0) chunks.push(chunk);
    }
    return chunks;
  }

  private scheduleFlush(chatId: number): void {
    const s = this.getState(chatId);
    if (s.timer) return;
    s.timer = setTimeout(() => this.flush(chatId), FLUSH_MS);
  }

  private attachChild(chatId: number, child: ChildProcess): void {
    const s = this.getState(chatId);
    child.stdout?.on('data', (data: Buffer) => {
      // Склеиваем с недополученным хвостом прошлого чанка — иначе строки,
      // разрезанные между data-событиями, приходят в чат обрывками.
      const text = s.partial + data.toString('utf8');
      const parts = text.split('\n');
      s.partial = parts.pop() ?? '';
      const lines = parts
        .map(stripControl)
        .map((line): string | null => {
          if (line.startsWith('Вы:')) {
            // Эхо введённой команды после промпта не показываем.
            return this.dropEcho(s, line.slice(3));
          }
          // PTY эхоит ввод отдельной строкой ещё до перерисовки промпта —
          // отсекаем строку, в точности повторяющую отправленную команду.
          const trimmed = line.trim().toLowerCase();
          if (s.lastInput && trimmed === s.lastInput) {
            s.lastInput = '';
            return null;
          }
          return line;
        })
        .filter(
          (line): line is string =>
            line !== null &&
            line.trim().length > 0 &&
            !this.isNoise(line) &&
            !STDERR_NOISE_PATTERNS.some((p) => p.test(line))
        );
      // Режимный парсер выделяет блок справки, даже если он пришёл частями.
      this.processLines(chatId, s, lines);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const msg = stripControl(data.toString('utf8')).trim();
      if (!msg) return;
      // Прячем внутренние варнинги Node.js (punycode и т.п.) — это не ошибки агента.
      if (STDERR_NOISE_PATTERNS.some((p) => p.test(msg))) {
        console.warn(`[telegram] stderr дочернего процесса скрыт: ${msg.split('\n')[0]}`);
        return;
      }
      s.buf.push(`\u26A0\uFE0F ${msg}`);
      this.scheduleFlush(chatId);
    });
    child.on('error', (err) => {
      s.lastErr = err.message;
      s.buf.push(`⛔ Ошибка дочернего процесса: ${err.message}`);
      this.flush(chatId);
    });
    child.on('exit', (code, signal) => {
      s.child = null;
      this.flush(chatId);
      const note =
        code === 0
          ? '🏁 Агент завершил работу.'
          : code !== null
            ? `⛔ Агент завершился с кодом ${code}.`
            : `⛔ Агент завершился сигналом ${signal}.`;
      this.bot.telegram.sendMessage(chatId, note).catch(() => {});
    });
  }

  private startAgent(chatId: number): void {
    const s = this.getState(chatId);
    if (s.child) {
      this.bot.telegram
        .sendMessage(chatId, 'Агент уже запущен. Пришлите /stop для остановки.')
        .catch(() => {});
      return;
    }
    // start:agent — tsx без nodemon: по команде exit процесс реально завершается,
    // а nodemon продолжал бы жить (п.5). Псевдо-TTY через `script`, иначе readline
    // в cli.ts закрывается по EOF и процесс умирает сразу после старта.
    // stty cols 1000 — отключаем PTY-перенос длинных строк, который резал вывод
    // на физические строки терминала и ломал склейку/парсинг.
    const child = spawn(
      'script',
      ['-qec', 'stty cols 1000 2>/dev/null; npm run --silent start:agent', '/dev/null'],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      }
    );
    s.child = child;
    s.lastErr = null;
    this.attachChild(chatId, child);
    this.bot.telegram.sendMessage(chatId, '⏳ Запускаю агента...').catch(() => {});
  }

  private stopAgent(chatId: number): void {
    const s = this.getState(chatId);
    if (!s.child) {
      this.bot.telegram.sendMessage(chatId, 'Агент не запущен.').catch(() => {});
      return;
    }
    this.bot.telegram.sendMessage(chatId, '🛑 Останавливаю агента...').catch(() => {});
    s.child.kill('SIGINT');
  }

  private statusAgent(chatId: number): void {
    const s = this.getState(chatId);
    const msg = s.child ? '✅ Агент запущен.' : '⏹ Агент не запущен.';
    this.bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }

  // Режимный разбор строк stdout: выделяет блок справки «Команды: ...» и
  // отправляет его отдельным HTML-сообщением, остальное копит в буфер.
  // Состояние (s.mode) сохраняется между data-событиями, поэтому блок может
  // приходить по одной строке за раз.
  private processLines(chatId: number, s: ChatState, lines: string[]): void {
    for (const line of lines) {
      if (s.mode === 'plain') {
        if (/^\s*Команды:\s*$/.test(line)) {
          s.mode = 'cmdHead';
        } else {
          s.buf.push(line);
        }
        continue;
      }
      if (s.mode === 'cmdHead') {
        const m = line.match(/^\s+(\S+(?:\s+[^ -]\S*)*)\s+-\s+(.+)$/);
        if (m) {
          s.cmdRows.push(this.formatCmdRow(m[1], m[2]));
          s.mode = 'cmdRows';
        } else {
          // Заголовок оказался не справкой — откатываемся в обычный режим.
          s.mode = 'plain';
          s.buf.push('Команды:', line);
        }
        continue;
      }
      // mode === 'cmdRows'
      const m = line.match(/^\s+(\S+(?:\s+[^ -]\S*)*)\s+-\s+(.+)$/);
      if (m) {
        s.cmdRows.push(this.formatCmdRow(m[1], m[2]));
        // Блок может не закрыться «чужой» строкой (агент ушёл в промпт) —
        // отправляем справку по таймеру после последней командной строки.
        this.scheduleCmdEmit(chatId, s);
      } else {
        this.emitCommandBlock(chatId, s);
        s.buf.push(line);
      }
    }
    this.scheduleFlush(chatId);
  }

  // Отложенная отправка справки: если после последней строки блока
  // ничего не пришло, считаем блок законченным.
  private cmdTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private scheduleCmdEmit(chatId: number, s: ChatState): void {
    const prev = this.cmdTimers.get(chatId);
    if (prev) clearTimeout(prev);
    this.cmdTimers.set(
      chatId,
      setTimeout(() => {
        this.cmdTimers.delete(chatId);
        this.emitCommandBlock(chatId, s);
      }, FLUSH_MS + 150)
    );
  }

  private formatCmdRow(cmd: string, desc: string): string {
    const emoji = COMMAND_EMOJI[cmd] ?? '\u{1F539}';
    return `${emoji} <code>${escapeHtml(cmd)}</code> — ${escapeHtml(desc)}`;
  }

  // Отправляет накопленную справку HTML-сообщением и сбрасывает режим парсера.
  private emitCommandBlock(chatId: number, s: ChatState): void {
    if (s.cmdRows.length === 0) {
      s.mode = 'plain';
      return;
    }
    const html = ['<b>Команды:</b>', ...s.cmdRows].join('\n');
    s.cmdRows = [];
    s.mode = 'plain';
    this.flush(chatId);
    this.sendHtml(chatId, html);
  }

  // Убирает из строки эхо команды, которую пользователь отправил в stdin.
  // Возвращает null, если после промпта осталось только эхо.
  private dropEcho(s: ChatState, rest: string): string | null {
    let text = rest.trim();
    const echo = s.lastInput;
    if (!echo) return text.length > 0 ? text : null;
    // PTY может обернуть длинную строку на несколько физических —
    // срезаем эхо посимвольно, сколько бы строк оно ни заняло.
    if (s.partial.length > 0) {
      const partialEcho = s.partial.replace(/\s+/g, '');
      if (partialEcho.length > 0 && echo.startsWith(partialEcho)) {
        s.partial = '';
        s.lastInput = echo.slice(partialEcho.length);
      }
    }
    const current = s.lastInput;
    if (current.length > 0 && text.length > 0 && current.startsWith(text.replace(/\s+/g, ''))) {
      s.lastInput = current.slice(text.replace(/\s+/g, '').length);
      return null;
    }
    if (current.length > 0 && text.toLowerCase().startsWith(current)) {
      text = text.slice(current.length).trim();
      s.lastInput = '';
    }
    return text.length > 0 ? text : null;
  }

  private sendHtml(chatId: number, html: string): void {
    for (const chunk of this.chunkText(html)) {
      this.bot.telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML' }).catch((e) => {
        console.error(`[telegram] sendMessage (HTML) to ${chatId} failed:`, e);
      });
    }
  }

  async run(): Promise<void> {
    this.bot.use(async (ctx, next) => {
      if (!this.isAllowed(ctx)) {
        await ctx.reply('⛔ У вас нет доступа к этому боту.');
        return;
      }
      return next();
    });

    this.bot.start((ctx) => this.startAgent(ctx.chat.id));
    this.bot.command('stop', (ctx) => this.stopAgent(ctx.chat.id));
    this.bot.command('status', (ctx) => this.statusAgent(ctx.chat.id));

    this.bot.on('text', (ctx) => {
      const chatId = ctx.chat.id;
      const s = this.getState(chatId);
      const text = ctx.message.text.trim();
      if (!text) return;
      if (!s.child || !s.child.stdin) {
        ctx.reply('Агент не запущен. Нажмите /start для запуска.').catch(() => {});
        return;
      }
      s.lastInput = text.toLowerCase();
      s.child.stdin.write(text + '\n', (err) => {
        if (err) {
          ctx.reply(`⚠️ Не удалось отправить команду агенту: ${err.message}`).catch(() => {});
        }
      });
    });

    if (this.allowed.size === 0) {
      console.warn('[telegram] TELEGRAM_ALLOWED_CHAT_IDS пуст — бот открыт для всех.');
    }

    await this.bot.launch();
    console.log('[telegram] Бот запущен.');

    const shutdown = async () => {
      console.log('[telegram] Остановка...');
      this.bot.stop();
      for (const [chatId, s] of this.sessions) {
        if (s.child) {
          s.child.kill('SIGINT');
          // Даём дочернему процессу шанс корректно завершиться.
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1500);
            s.child?.once('exit', () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        this.flush(chatId);
      }
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}

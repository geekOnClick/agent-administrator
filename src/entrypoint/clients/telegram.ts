import { Context, Telegraf } from 'telegraf';
import { ChatProcessor } from '../../llm/chat-processor.js';
import { message } from 'telegraf/filters';
import { AiEntryPointInterface } from '../types.js';

export class TelegramEntryPoint implements AiEntryPointInterface {
  constructor(private readonly processor: ChatProcessor) {}

  async run() {
    const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!TELEGRAM_TOKEN) {
      console.error('❌ Укажите TELEGRAM_BOT_TOKEN в .env');
      process.exit(1);
    }
    const bot = new Telegraf(TELEGRAM_TOKEN);
    bot.start(this.helpReply);
    bot.help(this.helpReply);
    bot.command('reset', async (ctx) => {
      await this.processor.resetSession(ctx.chat.id.toString());
      await ctx.reply('🔄 Сессия сброшена. Начните сначала.');
    });
    bot.on(message('text'), async (ctx) => {
      const sessionId = ctx.chat.id.toString();
      const query = ctx.message.text;
      const start = Date.now();
      const thinkResult = await ctx.reply('🤖 Думаю...'); // Сообщение для индикации процесса. Потом его удалим
      try {
        const response = await this.processor.processMessage(sessionId, query);
        const end = Date.now();
        const durationSec = ((end - start) / 1000).toFixed(2);

        await ctx.reply(`🤖 Ответ (${durationSec} сек):\n${response.message}`);
        await ctx.telegram.deleteMessage(ctx.chat.id, thinkResult.message_id);

        if (response.tools.length > 0) {
          const toolText = response.tools
            .map((tool, i) => `  ${i + 1}. ${tool.name} ${JSON.stringify(tool.arguments)}`)
            .join('\n');
          // Для отладки отправляем использованные инструменты.
          await ctx.reply(`🛠️ Использованные инструменты:\n${toolText}`);
        }
      } catch (err) {
        console.error('⚠️ Ошибка в обработке:', err);
        await ctx.reply('❌ Произошла ошибка при обработке запроса.');
      }
    });
    await bot.telegram.setMyCommands([
      {
        command: '/reset',
        description: 'Сбросить сессию'
      }
    ]);
    await bot.launch(() => {
      console.log('🚀 Telegram бот запущен');
    });
  }

  private helpReply(ctx: Context) {
    return ctx.reply(
      '👋 Привет! Я помощник. Напиши свой запрос. Напиши /reset для сброса истории.'
    );
  }
}

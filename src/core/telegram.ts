import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type Context } from 'grammy';

import type { AppConfig } from '../config.js';
import type { Logger } from '../lib/logger.js';

export function createTelegramBot(config: Pick<AppConfig, 'telegramBotToken'>, logger: Logger): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  bot.api.config.use(autoRetry());
  bot.catch((error) => {
    logger.error({
      event: 'telegram.middleware.unhandled_error',
      updateId: String(error.ctx.update.update_id),
      ...(error.ctx.chat ? { chatId: String(error.ctx.chat.id) } : {}),
      ...(error.ctx.from ? { userId: String(error.ctx.from.id) } : {}),
      error: { name: error.error instanceof Error ? error.error.name : 'UnknownError', message: error.error instanceof Error ? error.error.message : String(error.error) },
    });
  });
  return bot;
}

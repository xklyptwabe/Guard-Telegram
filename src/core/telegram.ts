import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, type BotError, type Context } from 'grammy';

import type { AppConfig } from '../config.js';
import type { Logger } from '../lib/logger.js';

/** Methods that must never be blindly re-issued by the HTTP client. */
const NON_IDEMPOTENT_API_METHODS = new Set(['deleteMessage']);

export function createTelegramBot(config: Pick<AppConfig, 'telegramBotToken'>, logger: Logger): Bot<Context> {
  const bot = new Bot<Context>(config.telegramBotToken);
  const retrySafe = autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 30,
    rethrowHttpErrors: true,
    rethrowInternalServerErrors: true,
  });
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (NON_IDEMPOTENT_API_METHODS.has(method)) {
      return prev(method, payload, signal);
    }
    return retrySafe(prev, method, payload, signal);
  });
  // Runner / handleUpdates path: never swallow transport or audit-pending —
  // rethrow so the caller can refuse to ack. Other errors stay logged.
  bot.catch((error: BotError) => {
    logger.error({
      event: 'telegram.middleware.unhandled_error',
      updateId: String(error.ctx.update.update_id),
      ...(error.ctx.chat ? { chatId: String(error.ctx.chat.id) } : {}),
      ...(error.ctx.from ? { userId: String(error.ctx.from.id) } : {}),
      error: { name: error.error instanceof Error ? error.error.name : 'UnknownError', message: error.error instanceof Error ? error.error.message : String(error.error) },
    });
    throw error;
  });
  return bot;
}

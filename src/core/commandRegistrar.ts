import type { Bot, Context } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { i18n } from 'i18next';

import type { TelegramBotModule, TelegramCommandDefinition } from './contracts.js';
import type { CommandDispatcher } from './dispatcher.js';
import type { Logger } from '../lib/logger.js';

export function collectCommands(modules: readonly TelegramBotModule[]): readonly TelegramCommandDefinition[] {
  return modules.flatMap((module) => module.commands ?? []);
}

/**
 * BOTS-9 review finding (HIGH-5) — documented exclusion: `setMyCommands`
 * is deliberately NOT routed through the write-ahead outbox. It runs once
 * per bootstrap, is idempotent (same args → same menu), and bootstrap
 * itself retries it on every restart — retry-by-restart is the recovery
 * mechanism here, and a DB roundtrip per call would buy nothing.
 */
export async function registerCommands(
  bot: Bot<Context>,
  modules: readonly TelegramBotModule[],
  dispatcher: CommandDispatcher,
  i18n: i18n,
  logger: Logger,
): Promise<void> {
  const commands = collectCommands(modules);
  const defaultMenu: BotCommand[] = commands.map((command) => ({ command: command.name, description: String(i18n.t(command.descriptionKey, { lng: 'ru' })) }));
  await bot.api.setMyCommands(defaultMenu);
  for (const languageCode of ['ru', 'en'] as const) {
    const menu: BotCommand[] = commands.map((command) => ({ command: command.name, description: String(i18n.t(command.descriptionKey, { lng: languageCode })) }));
    await bot.api.setMyCommands(menu, { language_code: languageCode });
  }
  for (const command of commands) {
    bot.command(command.name, (ctx) => dispatcher.dispatchCommand(ctx, command.name, typeof ctx.match === 'string' ? ctx.match : ''));
  }
  bot.on('callback_query:data', (ctx) => dispatcher.dispatchCallback(ctx));
  logger.info({ event: 'telegram.command_menu.registered', details: { commandCount: commands.length } });
}

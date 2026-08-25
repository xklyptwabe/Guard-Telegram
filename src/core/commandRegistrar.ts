import { randomUUID } from 'node:crypto';

import type { Bot, Context } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { i18n } from 'i18next';

import type { TelegramBotModule, TelegramCommandDefinition } from './contracts.js';
import type { CommandDispatcher } from './dispatcher.js';
import { integrationOperationMetadata } from '../lib/integrations/externalOperationGateway.js';
import type { Logger } from '../lib/logger.js';
import type { PendingOperationResolvers, PendingOperationsOutbox } from '../lib/moderation/pendingOperationsOutbox.js';

export function collectCommands(modules: readonly TelegramBotModule[]): readonly TelegramCommandDefinition[] {
  return modules.flatMap((module) => module.commands ?? []);
}

export async function registerCommands(
  bot: Bot<Context>,
  modules: readonly TelegramBotModule[],
  dispatcher: CommandDispatcher,
  i18n: i18n,
  logger: Logger,
  outbox?: PendingOperationsOutbox,
  resolvers?: PendingOperationResolvers,
): Promise<void> {
  const commands = collectCommands(modules);
  const kind = 'integration.telegram.setMyCommands';
  const execute = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const menu = payload.commands as BotCommand[];
    const languageCode = payload.language_code === 'ru' || payload.language_code === 'en' ? payload.language_code : undefined;
    await bot.api.setMyCommands(menu, languageCode === undefined ? undefined : { language_code: languageCode });
    return { commandCount: menu.length };
  };
  resolvers?.register(kind, execute, { retryAfterUnknown: true });
  const setCommands = async (menu: BotCommand[], languageCode?: 'ru' | 'en'): Promise<void> => {
    if (!outbox) {
      await bot.api.setMyCommands(menu, languageCode === undefined ? undefined : { language_code: languageCode });
      return;
    }
    const targetId = languageCode ?? 'default';
    const metadata = integrationOperationMetadata({ integrationId: 'telegram', action: 'setMyCommands', targetType: 'bot_command_scope', targetId });
    const result = await outbox.execute(
      {
        kind,
        chatId: 'platform',
        idempotencyKey: `telegram.setMyCommands:${randomUUID()}`,
        requestPayload: { commands: menu, ...(languageCode !== undefined ? { language_code: languageCode } : {}) },
        auditEvent: { eventType: 'integration.action', eventVersion: 'v1' },
        metadata,
        recoveryMetadata: metadata,
      },
      execute,
    );
    if (result.isFinal && !result.auditFinalized) throw new Error(`Telegram setMyCommands audit is still owed for ${targetId}`);
    if (result.outcome.status !== 'succeeded') throw new Error(`Telegram setMyCommands ${result.outcome.status} for ${targetId}`);
  };
  const defaultMenu: BotCommand[] = commands.map((command) => ({ command: command.name, description: String(i18n.t(command.descriptionKey, { lng: 'ru' })) }));
  await setCommands(defaultMenu);
  for (const languageCode of ['ru', 'en'] as const) {
    const menu: BotCommand[] = commands.map((command) => ({ command: command.name, description: String(i18n.t(command.descriptionKey, { lng: languageCode })) }));
    await setCommands(menu, languageCode);
  }
  for (const command of commands) {
    bot.command(command.name, (ctx) => dispatcher.dispatchCommand(ctx, command.name, typeof ctx.match === 'string' ? ctx.match : ''));
  }
  bot.on('callback_query:data', (ctx) => dispatcher.dispatchCallback(ctx));
  logger.info({ event: 'telegram.command_menu.registered', details: { commandCount: commands.length } });
}

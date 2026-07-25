import type { Context } from 'grammy';
import type { i18n } from 'i18next';

import { CALLBACK_VERSION } from '../constants.js';
import { localeForTelegram } from '../i18n/index.js';
import type { Cooldowns } from '../lib/cooldowns.js';
import type { EventBus } from '../lib/eventBus.js';
import type { Logger } from '../lib/logger.js';
import { hasPermission } from '../lib/permissions.js';
import type { ReplyService } from '../lib/reply.js';
import type { TelegramCommandDefinition } from './contracts.js';
import type { ModuleRegistry } from './registry.js';

interface CallbackEnvelope {
  readonly commandName: string;
  readonly rawArguments: string;
}

const callbackPattern = /^v1:([a-z][a-z0-9_]{0,31}):([A-Za-z0-9_-]*)$/;

function chatAndUser(ctx: Context): { chatId: string; userId: string } | undefined {
  if (!ctx.chat || !ctx.from) return undefined;
  return { chatId: String(ctx.chat.id), userId: String(ctx.from.id) };
}

export function encodeCallback(commandName: string, rawArguments = ''): string {
  const encodedArguments = Buffer.from(rawArguments, 'utf8').toString('base64url');
  const data = `${CALLBACK_VERSION}:${commandName}:${encodedArguments}`;
  if (Buffer.byteLength(data, 'utf8') > 64) throw new Error('Callback data exceeds Telegram 64-byte limit');
  return data;
}

export function decodeCallback(data: string): CallbackEnvelope | undefined {
  const match = callbackPattern.exec(data);
  if (!match) return undefined;
  try {
    return { commandName: match[1]!, rawArguments: Buffer.from(match[2]!, 'base64url').toString('utf8') };
  } catch {
    return undefined;
  }
}

export class CommandDispatcher {
  private readonly commandsByName: ReadonlyMap<string, TelegramCommandDefinition>;

  public constructor(
    commands: readonly TelegramCommandDefinition[],
    private readonly registry: ModuleRegistry,
    private readonly cooldowns: Cooldowns,
    private readonly reply: ReplyService,
    private readonly events: EventBus,
    private readonly i18n: i18n,
    private readonly logger: Logger,
  ) {
    this.commandsByName = new Map(commands.map((command) => [command.name, command]));
  }

  public async dispatchCommand(ctx: Context, commandName: string, rawArguments: string): Promise<void> {
    const command = this.commandsByName.get(commandName);
    const identity = chatAndUser(ctx);
    if (!command || !identity) return;
    const t = this.translator(ctx);
    const startedAt = Date.now();
    try {
      if (!(await this.registry.isEnabled(identity.chatId, command.moduleId))) {
        this.logger.warn({ event: 'command.feature_disabled', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName });
        await this.reply.send(ctx, t('common.featureDisabled'));
        return;
      }
      if (!(await hasPermission(ctx, command.permission))) {
        this.logger.warn({ event: 'command.permission_denied', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName });
        await this.reply.send(ctx, t('common.permissionDenied'));
        return;
      }
      if (!this.cooldowns.take(`${identity.chatId}:${identity.userId}:${command.id}`, command.cooldownMs)) {
        this.logger.warn({ event: 'command.cooldown_denied', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName });
        await this.reply.send(ctx, t('common.cooldown'));
        return;
      }
      const parsed = command.argsSchema.safeParse(rawArguments);
      if (!parsed.success) {
        this.logger.warn({ event: 'command.payload_rejected', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName });
        await this.reply.send(ctx, t('common.invalidArguments'));
        return;
      }
      await command.execute(
        {
          ctx,
          ...identity,
          moduleId: command.moduleId,
          registry: this.registry,
          logger: this.logger,
          reply: this.reply,
          events: this.events,
          t,
        },
        parsed.data,
      );
      this.logger.info({ event: 'command.completed', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName, durationMs: Date.now() - startedAt });
    } catch (error: unknown) {
      this.logger.error({ event: 'command.failed', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName, error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
      await this.reply.send(ctx, t('common.internalError')).catch((replyError: unknown) => {
        this.logger.error({ event: 'command.error_reply_failed', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName, error: { name: replyError instanceof Error ? replyError.name : 'UnknownError', message: replyError instanceof Error ? replyError.message : String(replyError) } });
      });
    }
  }

  public async dispatchCallback(ctx: Context): Promise<void> {
    const t = this.translator(ctx);
    try {
      const data = ctx.callbackQuery?.data;
      const envelope = data ? decodeCallback(data) : undefined;
      if (!envelope) {
        this.logger.warn({ event: 'callback.payload_rejected', ...(ctx.chat ? { chatId: String(ctx.chat.id) } : {}), ...(ctx.from ? { userId: String(ctx.from.id) } : {}) });
        await this.reply.send(ctx, t('common.invalidCallback'));
        return;
      }
      await this.dispatchCommand(ctx, envelope.commandName, envelope.rawArguments);
    } finally {
      await ctx.answerCallbackQuery({ text: t('common.callbackDone') }).catch((error: unknown) => {
        this.logger.error({ event: 'callback.answer_failed', ...(ctx.chat ? { chatId: String(ctx.chat.id) } : {}), ...(ctx.from ? { userId: String(ctx.from.id) } : {}), error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
      });
    }
  }

  private translator(ctx: Context): (key: string, options?: Record<string, string | number>) => string {
    const locale = localeForTelegram(ctx.from?.language_code);
    return (key, options) => String(this.i18n.t(key, { lng: locale, ...options }));
  }
}

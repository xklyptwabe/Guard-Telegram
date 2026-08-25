import type { Context } from 'grammy';
import type { i18n } from 'i18next';

import { CALLBACK_VERSION } from '../constants.js';
import { localeForTelegram } from '../i18n/index.js';
import {
  commandAuditOperationKind,
  commandAuditRecoveryMetadata,
  makeCommandAuditFinalizer,
  recordCommandExecuted as writeCommandExecutedAudit,
  type CommandExecutedAuditInput,
} from '../lib/audit/commandAudit.js';
import type { AuditService } from '../lib/auditService.js';
import type { Cooldowns } from '../lib/cooldowns.js';
import { getUpdateContext } from '../lib/context.js';
import type { EventBus } from '../lib/eventBus.js';
import type { Logger } from '../lib/logger.js';
import { bots9WalExclusion } from '../lib/bots9WalExclusions.js';
import { AuditFinalizationPendingError, type PendingOperationFinalizer, type PendingOperationsOutbox } from '../lib/moderation/pendingOperationsOutbox.js';
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

/**
 * BOTS-9 review round-2 (BLOCKER-4/HIGH-8): thrown when a command's
 * `command.executed` audit could not be written for an *infrastructure*
 * reason before durable command-audit debt could be established. Once the
 * checkpoint exists, an audit outage no longer throws this error: the inbox
 * may complete while the shared outbox backfills the one owed event. A
 * policy-disabled event maps to a normal success too.
 */
export class CommandAuditPendingError extends AuditFinalizationPendingError {
  public constructor(commandName: string, cause: unknown) {
    super(`command.executed audit for "${commandName}" is still owed (infrastructure failure)`);
    this.name = 'CommandAuditPendingError';
    this.cause = cause;
  }
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
  // BOTS-9: audits every command execution (never the raw arguments — see
  // `argsRedacted: true` below, always true, since we never capture them at
  // all). Only wraps `command.execute()` itself, not the earlier gates
  // (disabled/permission/cooldown/invalid-args) — those are access-control
  // denials with their own `logger.warn` already, not "the module ran".
  private readonly commandAuditFinalizer: PendingOperationFinalizer;

  public constructor(
    commands: readonly TelegramCommandDefinition[],
    private readonly registry: ModuleRegistry,
    private readonly cooldowns: Cooldowns,
    private readonly reply: ReplyService,
    private readonly events: EventBus,
    private readonly i18n: i18n,
    private readonly logger: Logger,
    private readonly audit: AuditService,
    private readonly outbox?: PendingOperationsOutbox,
  ) {
    this.commandsByName = new Map(commands.map((command) => [command.name, command]));
    this.commandAuditFinalizer = makeCommandAuditFinalizer(audit, logger);
  }

  public async dispatchCommand(ctx: Context, commandName: string, rawArguments: string): Promise<void> {
    const command = this.commandsByName.get(commandName);
    const identity = chatAndUser(ctx);
    if (!command || !identity) return;
    const t = this.translator(ctx);
    const startedAt = Date.now();
    const cooldownKey = `${identity.chatId}:${identity.userId}:${command.id}`;
    const auditIdempotencyKey = this.commandAuditIdempotencyKey(identity, command, commandName);
    if (auditIdempotencyKey && this.outbox) {
      try {
        const resumed = await this.outbox.resume(auditIdempotencyKey, () => Promise.resolve({}), this.commandAuditFinalizer);
        if (resumed) {
          this.logger.info({ event: 'audit.command_executed.resumed_without_command', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName });
          return;
        }
      } catch (error: unknown) {
        throw new CommandAuditPendingError(commandName, error);
      }
    }
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
      if (!this.cooldowns.take(cooldownKey, command.cooldownMs)) {
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
      const durationMs = Date.now() - startedAt;
      this.logger.info({ event: 'command.completed', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName, durationMs });
      await this.recordCommandExecuted(identity, command, commandName, durationMs, true, auditIdempotencyKey);
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      // A nested outbox-backed command may still report that its own durable
      // audit checkpoint could not be established. Propagate that state; a
      // completed command's own command.audit row does not reach this branch
      // when only its final AuditService call is temporarily unavailable.
      if (error instanceof AuditFinalizationPendingError) {
        this.cooldowns.release(cooldownKey);
        throw error;
      }
      this.logger.error({ event: 'command.failed', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName, error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
      // The failed outcome uses the same durable audit-debt path as success.
      try {
        await this.recordCommandExecuted(identity, command, commandName, durationMs, false, auditIdempotencyKey);
      } catch (auditError: unknown) {
        this.cooldowns.release(cooldownKey);
        if (auditError instanceof AuditFinalizationPendingError) throw auditError;
        throw auditError;
      }
      await this.reply.send(ctx, t('common.internalError')).catch((replyError: unknown) => {
        this.logger.error({ event: 'command.error_reply_failed', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName, error: { name: replyError instanceof Error ? replyError.name : 'UnknownError', message: replyError instanceof Error ? replyError.message : String(replyError) } });
      });
    }
  }

  /**
   * Records a `command.executed` audit event. Log-like: the full record
   * (before=not_applicable, after=observed with the outcome) is known
   * upfront; there's no local business mutation of its own to protect here,
   * because `command.execute()` already ran.
   *
   * `idempotencyKey` is keyed on the Telegram update — same pattern Maxim
   * used for `module.state.changed` — so a redelivered Update never
   * produces a second `command.executed` row for the same invocation.
   *
   * The shared outbox stores the completed command's safe outcome before
   * audit finalization. An audit outage therefore leaves durable debt for
   * the background worker without failing the update or replaying the
   * command. Only a failure to establish that durable checkpoint throws
   * {@link CommandAuditPendingError}.
   */
  private async recordCommandExecuted(
    identity: { chatId: string; userId: string },
    command: TelegramCommandDefinition,
    commandName: string,
    durationMs: number,
    success: boolean,
    idempotencyKey: string | undefined,
  ): Promise<void> {
    if (!idempotencyKey) return;
    const input: CommandExecutedAuditInput = {
      chatId: identity.chatId,
      userId: identity.userId,
      moduleId: command.moduleId,
      commandName,
      durationMs,
      success,
      idempotencyKey,
    };
    try {
      if (!this.outbox) {
        await writeCommandExecutedAudit(this.audit, this.logger, input);
        return;
      }
      const metadata = commandAuditRecoveryMetadata(input);
      await this.outbox.execute(
        {
          kind: commandAuditOperationKind,
          chatId: identity.chatId,
          idempotencyKey,
          requestPayload: {},
          auditEvent: { eventType: 'command.executed', eventVersion: 'v1', moduleId: command.moduleId },
          metadata,
          recoveryMetadata: metadata,
        },
        () => Promise.resolve({}),
        this.commandAuditFinalizer,
      );
    } catch (error: unknown) {
      throw new CommandAuditPendingError(commandName, error);
    }
  }

  private commandAuditIdempotencyKey(
    identity: { chatId: string; userId: string },
    command: TelegramCommandDefinition,
    commandName: string,
  ): string | undefined {
    const context = getUpdateContext();
    if (!context) {
      this.logger.warn({ event: 'audit.command_executed.missing_update_context', module: command.moduleId, chatId: identity.chatId, userId: identity.userId, commandName });
      return undefined;
    }
    return `command.executed:telegram-update:${context.botId ?? 'unscoped-bot'}:${context.updateId}:${identity.chatId}:${identity.userId}:${commandName}`;
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
      // BOTS-9 review finding (HIGH-5) — documented exclusion:
      // answerCallbackQuery only dismisses the client-side loading spinner
      // on the button the user just pressed; it expires within seconds and
      // has no lasting state. A write-ahead/retry would be pure overhead
      // with a stale-ack as its only possible outcome.
      void bots9WalExclusion('telegram.answerCallbackQuery');
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

import type { Bot, Context } from 'grammy';
import type { ChatPermissions } from '@grammyjs/types';

import { getUpdateContext } from '../context.js';
import type { Logger } from '../logger.js';
import { normalizeError } from '../logger.js';
import type { AuditService } from '../auditService.js';
import { AuditEventProcessor } from '../audit/eventProcessor.js';
import { safeDownstreamMutationResult } from '../audit/mutationResult.js';
import { observed, notApplicable } from '../audit/snapshot.js';
import { recordMessageDeleted } from '../audit/messageAudit.js';
import { type AttemptOutcome, type PendingOperationRow, type PendingOperationResolvers, type PendingOperationsOutbox } from './pendingOperationsOutbox.js';

export type ModerationAction = 'ban' | 'kick' | 'mute' | 'unban' | 'unmute';

export interface ModerationActionInput {
  readonly chatId: string;
  readonly targetUserId: string;
  readonly actorUserId: string;
  readonly reason?: string;
}

export interface RestrictActionInput extends ModerationActionInput {
  readonly durationSeconds: number;
}

/** What a caller (a command handler) needs to tell the admin what happened. */
export interface ModerationOutcome {
  readonly status: 'succeeded' | 'failed' | 'unknown';
  readonly willRetry: boolean;
  readonly detail?: Record<string, unknown>;
}

const MUTED_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
};

const UNMUTED_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
};

/**
 * BOTS-9: connects ban/unban/restrict(mute)/unrestrict(unmute)/kick to
 * real Telegram Bot API calls, each made reliable through
 * `PendingOperationsOutbox` (write-ahead, retry, restart recovery,
 * confirmed-failure-vs-timeout), and each producing exactly one
 * `moderation.action` audit record once — and only once — the outcome is
 * final. See `pendingOperationsOutbox.ts`'s "ONE FINAL RECORD" note.
 *
 * Every call into the outbox carries `metadata` (actor/target/action/
 * reason) alongside the Telegram-bound `requestPayload`. That's what lets
 * `recoverPending()` write a *correct* audit record for an operation that
 * only resolves after a restart, when there is no live Update or actor on
 * the call stack to ask — only what was durably written ahead.
 */
export class ModerationService {
  private readonly auditProcessor = new AuditEventProcessor();

  public constructor(
    private readonly bot: Bot<Context>,
    private readonly audit: AuditService,
    private readonly outbox: PendingOperationsOutbox,
    private readonly resolvers: PendingOperationResolvers,
    private readonly logger: Logger,
  ) {
    this.registerResolvers();
  }

  public async ban(input: ModerationActionInput): Promise<ModerationOutcome> {
    return this.performAndAudit('ban', input, 'telegram.banChatMember', { chat_id: Number(input.chatId), user_id: Number(input.targetUserId) });
  }

  public async unban(input: ModerationActionInput): Promise<ModerationOutcome> {
    return this.performAndAudit('unban', input, 'telegram.unbanChatMember', { chat_id: Number(input.chatId), user_id: Number(input.targetUserId), only_if_banned: true });
  }

  public async restrict(input: RestrictActionInput): Promise<ModerationOutcome> {
    const untilDate = Math.floor(Date.now() / 1000) + input.durationSeconds;
    return this.performAndAudit('mute', input, 'telegram.restrictChatMember.mute', {
      chat_id: Number(input.chatId),
      user_id: Number(input.targetUserId),
      permissions: MUTED_PERMISSIONS,
      until_date: untilDate,
    });
  }

  public async unrestrict(input: ModerationActionInput): Promise<ModerationOutcome> {
    return this.performAndAudit('unmute', input, 'telegram.restrictChatMember.unmute', {
      chat_id: Number(input.chatId),
      user_id: Number(input.targetUserId),
      permissions: UNMUTED_PERMISSIONS,
    });
  }

  /** Telegram convention for "remove without a permanent ban": ban, then immediately unban with `only_if_banned`. Modeled as two independent, individually-reliable outbox operations rather than one, so a crash between the two steps is still recoverable per-step. */
  public async kick(input: ModerationActionInput): Promise<ModerationOutcome> {
    const banResult = await this.dispatch('kick.ban', input, 'telegram.banChatMember', { chat_id: Number(input.chatId), user_id: Number(input.targetUserId) });
    if (!banResult.isFinal) return { status: 'unknown', willRetry: true };
    if (banResult.outcome.status !== 'succeeded') {
      await this.recordModerationAction('kick', input, banResult.row.idempotencyKey, banResult.outcome);
      return this.toOutcome(banResult.outcome);
    }
    const unbanResult = await this.dispatch('kick.unban', input, 'telegram.unbanChatMember', { chat_id: Number(input.chatId), user_id: Number(input.targetUserId), only_if_banned: true });
    if (unbanResult.isFinal) await this.recordModerationAction('kick', input, unbanResult.row.idempotencyKey, unbanResult.outcome);
    return unbanResult.isFinal ? this.toOutcome(unbanResult.outcome) : { status: 'unknown', willRetry: true };
  }

  public async deleteMessage(chatId: string, messageId: string, actorUserId: string, knownAuthorUserId?: string): Promise<ModerationOutcome> {
    const context = getUpdateContext();
    const idempotencyKey = context ? `moderation.delete:telegram-update:${context.updateId}:${chatId}:${messageId}` : `moderation.delete:${chatId}:${messageId}:${Date.now()}`;
    const kind = 'telegram.deleteMessage';
    const result = await this.outbox.execute(
      {
        kind,
        chatId,
        idempotencyKey,
        requestPayload: { chat_id: Number(chatId), message_id: Number(messageId) },
        metadata: { deletedBy: actorUserId, ...(knownAuthorUserId !== undefined ? { knownAuthorUserId } : {}) },
      },
      this.resolvers.get(kind)!,
    );
    if (result.isFinal && result.outcome.status === 'succeeded') {
      await recordMessageDeleted(this.audit, this.logger, {
        chatId,
        messageId,
        idempotencyKey: `${result.row.idempotencyKey}:audit`,
        deletedBy: actorUserId,
        ...(knownAuthorUserId !== undefined ? { knownAuthorUserId } : {}),
      });
    }
    return result.isFinal ? this.toOutcome(result.outcome) : { status: 'unknown', willRetry: true };
  }

  /**
   * Resumes anything left `pending`/`in_progress` (interrupted by a crash)
   * or `unknown`-with-retries-remaining from before this process started.
   * Call once at startup, after `bot.init()`. Reconstructs and writes the
   * audit record for anything that resolves here — the *only* place a
   * recovered operation's audit trail gets completed, since the original
   * command's request/response cycle is long gone.
   */
  public async recoverPending(): Promise<void> {
    await this.outbox.recoverPending(async (row, outcome) => {
      await this.auditRecoveredOperation(row, outcome);
    });
  }

  private registerResolvers(): void {
    this.resolvers.register('telegram.banChatMember', async (payload) => {
      await this.bot.api.raw.banChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number });
    });
    this.resolvers.register('telegram.unbanChatMember', async (payload) => {
      await this.bot.api.raw.unbanChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number, only_if_banned: true });
    });
    this.resolvers.register('telegram.restrictChatMember.mute', async (payload) => {
      await this.bot.api.raw.restrictChatMember({
        chat_id: payload.chat_id as number,
        user_id: payload.user_id as number,
        permissions: payload.permissions as ChatPermissions,
        until_date: payload.until_date as number,
      });
    });
    this.resolvers.register('telegram.restrictChatMember.unmute', async (payload) => {
      await this.bot.api.raw.restrictChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number, permissions: payload.permissions as ChatPermissions });
    });
    this.resolvers.register('telegram.deleteMessage', async (payload) => {
      await this.bot.api.raw.deleteMessage({ chat_id: payload.chat_id as number, message_id: payload.message_id as number });
    });
  }

  private async dispatch(idempotencySuffix: string, input: ModerationActionInput, kind: string, requestPayload: Record<string, unknown>) {
    const context = getUpdateContext();
    const idempotencyKey = context
      ? `moderation.action:telegram-update:${context.updateId}:${input.chatId}:${input.targetUserId}:${idempotencySuffix}`
      : `moderation.action:${input.chatId}:${input.targetUserId}:${idempotencySuffix}:${Date.now()}`;
    const action = idempotencySuffix.replace(/^kick\.(ban|unban)$/, 'kick') as ModerationAction;
    const metadata: Record<string, unknown> = { action, actorUserId: input.actorUserId, targetUserId: input.targetUserId, ...(input.reason !== undefined ? { reason: input.reason } : {}) };
    return this.outbox.execute({ kind, chatId: input.chatId, idempotencyKey, requestPayload, metadata }, this.resolvers.get(kind)!);
  }

  private async performAndAudit(action: ModerationAction, input: ModerationActionInput, kind: string, requestPayload: Record<string, unknown>): Promise<ModerationOutcome> {
    const result = await this.dispatch(action, input, kind, requestPayload);
    if (result.isFinal) await this.recordModerationAction(action, input, result.row.idempotencyKey, result.outcome);
    return result.isFinal ? this.toOutcome(result.outcome) : { status: 'unknown', willRetry: true };
  }

  private toOutcome(outcome: AttemptOutcome): ModerationOutcome {
    return { status: outcome.status, willRetry: false, ...(outcome.result !== undefined ? { detail: outcome.result } : {}) };
  }

  /** A row resolving during `recoverPending()` has no live command/actor on the call stack — everything needed comes from what was written ahead in `row.metadata` and `row.chatId`. `telegram.deleteMessage` and the moderation-action kinds need different audit events, so this dispatches on `row.kind`. */
  private async auditRecoveredOperation(row: PendingOperationRow, outcome: AttemptOutcome): Promise<void> {
    if (row.kind === 'telegram.deleteMessage') {
      if (outcome.status !== 'succeeded') return; // only a successful deletion is auditable as message.deleted
      const messageId = String(row.requestPayload.message_id);
      const deletedBy = typeof row.metadata.deletedBy === 'string' ? row.metadata.deletedBy : undefined;
      const knownAuthorUserId = typeof row.metadata.knownAuthorUserId === 'string' ? row.metadata.knownAuthorUserId : undefined;
      await recordMessageDeleted(this.audit, this.logger, {
        chatId: row.chatId,
        messageId,
        idempotencyKey: `${row.idempotencyKey}:audit`,
        ...(deletedBy !== undefined ? { deletedBy } : {}),
        ...(knownAuthorUserId !== undefined ? { knownAuthorUserId } : {}),
      });
      return;
    }

    const action = typeof row.metadata.action === 'string' ? (row.metadata.action as ModerationAction) : undefined;
    const targetUserId = typeof row.metadata.targetUserId === 'string' ? row.metadata.targetUserId : undefined;
    const actorUserId = typeof row.metadata.actorUserId === 'string' ? row.metadata.actorUserId : undefined;
    if (!action || !targetUserId || !actorUserId) {
      this.logger.warn({ event: 'audit.moderation_action.recovered_without_metadata', chatId: row.chatId, details: { kind: row.kind, id: row.id } });
      return;
    }
    const reason = typeof row.metadata.reason === 'string' ? row.metadata.reason : undefined;
    await this.recordModerationAction(action, { chatId: row.chatId, targetUserId, actorUserId, ...(reason !== undefined ? { reason } : {}) }, row.idempotencyKey, outcome);
  }

  /** Writes the one-and-only `moderation.action` audit record for this operation. `outcome.status` maps directly onto BOTS-7's `AuditOperation`: a confirmed Telegram-side error is `'failed'`, an unresolved timeout is `'unknown'` — both first-class, not shoehorned into `'update'`. `pendingOperationIdempotencyKey` is the stable key already on the `pending_operations` row — reused (with an `:audit` suffix) rather than re-derived, so this works identically whether called from a live command or from `recoverPending()`. */
  private async recordModerationAction(action: ModerationAction, input: ModerationActionInput, pendingOperationIdempotencyKey: string, outcome: AttemptOutcome): Promise<void> {
    const idempotencyKey = `${pendingOperationIdempotencyKey}:audit`;
    const subjectType = 'chat_member_moderation';
    const subjectId = `${input.chatId}:${input.targetUserId}`;
    const operation = outcome.status === 'succeeded' ? 'create' : outcome.status;

    try {
      await this.audit.recordEntityChange(
        {
          tenantId: input.chatId,
          subjectType,
          subjectId,
          eventType: 'moderation.action',
          eventVersion: 'v1',
          category: 'moderation',
          source: 'telegram.moderation_command',
          idempotencyKey,
          actorId: input.actorUserId,
          actorType: 'telegram_user',
        },
        () => {
          const record = this.auditProcessor.process({
            name: 'moderation.action',
            version: 1,
            operation,
            chatId: input.chatId,
            actorId: input.actorUserId,
            before: notApplicable(),
            after:
              outcome.status === 'succeeded'
                ? observed({ chatId: input.chatId, targetUserId: input.targetUserId, actorUserId: input.actorUserId, action, ...(input.reason !== undefined ? { reason: input.reason } : {}) })
                : notApplicable(),
          });
          const mutationResult = safeDownstreamMutationResult(record, { chatId: input.chatId, targetUserId: input.targetUserId, action, outcome: outcome.status });
          return Promise.resolve({ ...mutationResult, metadata: { operation, ...(outcome.result !== undefined ? { result: outcome.result } : {}) } });
        },
      );
    } catch (error) {
      this.logger.warn({ event: 'audit.moderation_action.failed', chatId: input.chatId, details: { action }, error: normalizeError(error) });
    }
  }
}

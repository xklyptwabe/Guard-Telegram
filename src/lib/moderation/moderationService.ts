import { GrammyError, type Bot, type Context } from 'grammy';
import type { ChatPermissions } from '@grammyjs/types';

import { MODULE_IDS } from '../../constants.js';
import { getUpdateContext } from '../context.js';
import type { Logger } from '../logger.js';
import { normalizeError } from '../logger.js';
import { AuditPolicyDisabledError, type AuditService } from '../auditService.js';
import { AuditEventProcessor } from '../audit/eventProcessor.js';
import { safeDownstreamMutationResult } from '../audit/mutationResult.js';
import { observed, notApplicable } from '../audit/snapshot.js';
import { recordMessageDeleted } from '../audit/messageAudit.js';
import { type AttemptOutcome, AuditFinalizationPendingError, type PendingOperationRow, type PendingOperationResolvers, type PendingOperationsOutbox } from './pendingOperationsOutbox.js';

/**
 * BOTS-9 review round-2 (BLOCKER-4): thrown when a moderation operation
 * reached a terminal outcome but its mandatory terminal audit record is
 * still owed (finalizer failed). The caller must propagate this all the way
 * up so the durable inbox does NOT complete the update — Telegram redelivers
 * it, the outbox finds the row terminal, and the duplicate branch finishes
 * the audit idempotently. Policy-skips do NOT reach here (`auditFinalized`
 * is true for them).
 */
export class ModerationAuditPendingError extends AuditFinalizationPendingError {
  public constructor(rowId: string, kind: string) {
    super(`Terminal moderation operation ${rowId} (${kind}) resolved but its mandatory audit record is still owed`);
    this.name = 'ModerationAuditPendingError';
  }
}

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
    return this.performAndAudit('mute', input, 'telegram.restrictChatMember.mute', {
      chat_id: Number(input.chatId),
      user_id: Number(input.targetUserId),
      permissions: MUTED_PERMISSIONS,
      duration_seconds: input.durationSeconds,
      until_date: Math.floor(Date.now() / 1000) + input.durationSeconds,
    });
  }

  public async unrestrict(input: ModerationActionInput): Promise<ModerationOutcome> {
    return this.performAndAudit('unmute', input, 'telegram.restrictChatMember.unmute', {
      chat_id: Number(input.chatId),
      user_id: Number(input.targetUserId),
      permissions: UNMUTED_PERMISSIONS,
    });
  }

  /**
   * Telegram has no atomic "kick" primitive — the Bot API idiom is
   * ban-then-immediately-unban. This is modeled as a **single** outbox
   * operation whose executor performs both calls, rather than two separate
   * `pending_operations` rows. That's deliberate: with two rows, a crash
   * between "ban succeeded" and "the unban row gets written" left nothing
   * on disk saying an unban was still owed — the target would stay banned
   * forever with no way for `recoverPending()` to know to finish the job.
   * With one row, a crash anywhere in the executor just leaves it
   * `in_progress`/`unknown`; recovery re-invokes the *whole* executor, and
   * both Telegram calls are naturally idempotent (banning an
   * already-banned user, or unbanning with `only_if_banned`, are no-ops),
   * so replaying the pair from the top is always safe.
   *
   * The one case this does *not* paper over: a **confirmed** rejection
   * (`GrammyError`) on the unban half after the ban half already
   * succeeded. That is terminal by design (see
   * `pendingOperationsOutbox.ts` — a confirmed failure is never retried),
   * so it can leave the target banned rather than kicked. That's inherent
   * to Telegram's own two-call idiom, not a gap in this recovery — an
   * operator needs to look at it, same as any other confirmed failure.
   */
  public async kick(input: ModerationActionInput): Promise<ModerationOutcome> {
    return this.performAndAudit('kick', input, 'telegram.kick', { chat_id: Number(input.chatId), user_id: Number(input.targetUserId) });
  }

  public async deleteMessage(chatId: string, messageId: string, actorUserId: string, knownAuthorUserId?: string): Promise<ModerationOutcome> {
    const context = getUpdateContext();
    const idempotencyKey = context
      ? `moderation.delete:telegram-update:${context.botId ?? 'unscoped-bot'}:${context.updateId}:${chatId}:${messageId}`
      : `moderation.delete:${chatId}:${messageId}:${actorUserId}`;
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
      // HIGH-3: the outbox owns audit-finalization durability — on success it
      // marks audit_status='written'; a throw here leaves the audit owed and
      // the worker backfills it later without re-invoking the executor.
      async (row, outcome) => this.auditRecoveredOperation(row, outcome),
    );
    // BLOCKER-4: a terminal outcome whose mandatory audit is still owed must
    // fail the update chain (inbox not completed → Telegram redelivers →
    // duplicate branch finishes the audit).
    if (result.isFinal && !result.auditFinalized) throw new ModerationAuditPendingError(result.row.id, kind);
    return result.isFinal ? this.toOutcome(result.outcome) : { status: 'unknown', willRetry: true };
  }

  /**
   * Resumes anything left `pending`/`in_progress` (interrupted by a crash)
   * or `unknown`-with-retries-remaining from before this process started —
   * a single synchronous sweep. Reconstructs and writes the audit record
   * for anything that resolves here — the *only* place a recovered
   * operation's audit trail gets completed for a genuinely finished
   * process, since the original command's request/response cycle is long
   * gone. Kept as a direct method (rather than folded only into
   * `startWorker`) for tests and for the very first pass at boot.
   */
  public async recoverPending(): Promise<void> {
    await this.outbox.recoverPending(async (row, outcome) => this.auditRecoveredOperation(row, outcome));
  }

  /**
   * BOTS-9 review fix (BLOCKER-2): starts the outbox's persistent polling
   * worker so retries happen throughout the process's uptime, not only
   * once at bootstrap. Call once at startup, after `bot.init()` — the
   * first poll tick performs the same initial sweep `recoverPending()`
   * used to do alone, then continues polling on an interval for as long
   * as the process runs. Call `stopWorker()` during graceful shutdown.
   */
  public startWorker(): void {
    this.outbox.startWorker(async (row, outcome) => this.auditRecoveredOperation(row, outcome));
  }

  public stopWorker(): void {
    this.outbox.stopWorker();
  }

  private registerResolvers(): void {
    this.resolvers.register(
      'telegram.banChatMember',
      async (payload) => {
        await this.bot.api.raw.banChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number });
      },
      { retryAfterUnknown: true },
    );
    this.resolvers.register(
      'telegram.unbanChatMember',
      async (payload) => {
        await this.bot.api.raw.unbanChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number, only_if_banned: true });
      },
      { retryAfterUnknown: true },
    );
    this.resolvers.register(
      'telegram.kick',
      async (payload) => {
      // Both calls are individually idempotent — safe to replay this whole
      // executor from the top on recovery, whichever half it died on.
      await this.bot.api.raw.banChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number });
      try {
        await this.bot.api.raw.unbanChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number, only_if_banned: true });
      } catch (error) {
        if (error instanceof GrammyError && (error.error_code === 429 || error.error_code >= 500)) {
          throw new Error(`kick unban transient ${error.error_code}: ${error.description}`);
        }
        // Confirmed unban rejection after ban landed — not kicked.
        if (error && typeof error === 'object') (error as Record<string, unknown>).partialOutcome = 'banned_not_kicked';
        throw error;
      }
    },
      { retryAfterUnknown: true },
    );
    this.resolvers.register(
      'telegram.restrictChatMember.mute',
      async (payload) => {
        const untilDate = typeof payload.until_date === 'number' ? payload.until_date : Math.floor(Date.now() / 1000) + (typeof payload.duration_seconds === 'number' ? payload.duration_seconds : 0);
        await this.bot.api.raw.restrictChatMember({
          chat_id: payload.chat_id as number,
          user_id: payload.user_id as number,
          permissions: payload.permissions as ChatPermissions,
          until_date: untilDate,
        });
      },
      { retryAfterUnknown: true },
    );
    this.resolvers.register(
      'telegram.restrictChatMember.unmute',
      async (payload) => {
        await this.bot.api.raw.restrictChatMember({ chat_id: payload.chat_id as number, user_id: payload.user_id as number, permissions: payload.permissions as ChatPermissions });
      },
      { retryAfterUnknown: true },
    );
    // BOTS-9 review round-2 (BLOCKER-2): deleteMessage is destructive and
    // NOT provably idempotent — a re-issued delete on an already-deleted
    // message returns a confirmed error, misreporting a real success as
    // failed. Unknown → terminal, never a blind retry.
    this.resolvers.register(
      'telegram.deleteMessage',
      async (payload) => {
        await this.bot.api.raw.deleteMessage({ chat_id: payload.chat_id as number, message_id: payload.message_id as number });
      },
      { retryAfterUnknown: false },
    );
  }

  private async dispatch(action: ModerationAction, input: ModerationActionInput, kind: string, requestPayload: Record<string, unknown>) {
    const context = getUpdateContext();
    const durationKey = typeof requestPayload.duration_seconds === 'number' ? `:${requestPayload.duration_seconds}` : '';
    const idempotencyKey = context
      ? `moderation.action:telegram-update:${context.botId ?? 'unscoped-bot'}:${context.updateId}:${input.chatId}:${input.targetUserId}:${action}`
      : `moderation.action:${input.chatId}:${input.targetUserId}:${action}${durationKey}`;
    const reason = input.reason !== undefined ? input.reason.slice(0, 500) : undefined;
    const metadata = await this.audit.maskOutboxMetadata({
      tenantId: input.chatId,
      eventType: 'moderation.action',
      eventVersion: 'v1',
      moduleId: MODULE_IDS.moderation,
      metadata: { action, actorUserId: input.actorUserId, targetUserId: input.targetUserId, ...(reason !== undefined && reason.length > 0 ? { reason } : {}) },
    });
    return this.outbox.execute(
      { kind, chatId: input.chatId, idempotencyKey, requestPayload, metadata },
      this.resolvers.get(kind)!,
      // HIGH-3: audit-finalization is the outbox's durable responsibility —
      // see deleteMessage's note. auditRecoveredOperation dispatches on
      // row.kind, so this same callback serves both recovery and live calls.
      async (row, outcome) => this.auditRecoveredOperation(row, outcome),
    );
  }

  private async performAndAudit(action: ModerationAction, input: ModerationActionInput, kind: string, requestPayload: Record<string, unknown>): Promise<ModerationOutcome> {
    const result = await this.dispatch(action, input, kind, requestPayload);
    // BLOCKER-4: same mandatory-audit propagation as deleteMessage.
    if (result.isFinal && !result.auditFinalized) throw new ModerationAuditPendingError(result.row.id, kind);
    return result.isFinal ? this.toOutcome(result.outcome) : { status: 'unknown', willRetry: true };
  }

  private toOutcome(outcome: AttemptOutcome): ModerationOutcome {
    return { status: outcome.status, willRetry: false, ...(outcome.result !== undefined ? { detail: outcome.result } : {}) };
  }

  /** A row resolving during `recoverPending()` has no live command/actor on the call stack — everything needed comes from what was written ahead in `row.metadata` and `row.chatId`. `telegram.deleteMessage` and the moderation-action kinds need different audit events, so this dispatches on `row.kind`. Public so the shared outbox finalizer router (see core wiring / the integration gateway) can delegate `telegram.*` kinds here. */
  public async auditRecoveredOperation(row: PendingOperationRow, outcome: AttemptOutcome): Promise<{ readonly status: 'recorded' } | { readonly status: 'policy_skipped' }> {
    if (row.kind === 'telegram.deleteMessage') {
      const messageId = String(row.requestPayload.message_id);
      const deletedBy = typeof row.metadata.deletedBy === 'string' ? row.metadata.deletedBy : undefined;
      const knownAuthorUserId = typeof row.metadata.knownAuthorUserId === 'string' ? row.metadata.knownAuthorUserId : undefined;
      return recordMessageDeleted(this.audit, this.logger, {
        chatId: row.chatId,
        messageId,
        idempotencyKey: `${row.idempotencyKey}:audit`,
        outcome: outcome.status,
        ...(deletedBy !== undefined ? { deletedBy } : {}),
        ...(knownAuthorUserId !== undefined ? { knownAuthorUserId } : {}),
      });
    }

    const action = typeof row.metadata.action === 'string' ? (row.metadata.action as ModerationAction) : undefined;
    const targetUserId = typeof row.metadata.targetUserId === 'string' ? row.metadata.targetUserId : undefined;
    const actorUserId = typeof row.metadata.actorUserId === 'string' ? row.metadata.actorUserId : undefined;
    if (!action || !targetUserId || !actorUserId) {
      // BLOCKER-1: missing audit metadata must NEVER finalize as 'written'.
      // Throw — the outbox keeps `audit_status='pending'` and the backfill
      // pass keeps retrying (loudly logged) until an operator fixes or
      // skips the row. Silent completion with zero events is the exact bug
      // the review forbids.
      this.logger.error({ event: 'audit.moderation_action.recovered_without_metadata', chatId: row.chatId, details: { kind: row.kind, id: row.id } });
      throw new Error(`pending_operations row ${row.id} (${row.kind}) reached terminal state without the audit metadata needed to finalize its record`);
    }
    const reason = typeof row.metadata.reason === 'string' ? row.metadata.reason : undefined;
    return this.recordModerationAction(action, { chatId: row.chatId, targetUserId, actorUserId, ...(reason !== undefined ? { reason } : {}) }, row.idempotencyKey, outcome);
  }

  /** Writes the one-and-only `moderation.action` audit record for this operation. `outcome.status` maps directly onto BOTS-7's `AuditOperation`: a confirmed Telegram-side error is `'failed'`, an unresolved timeout is `'unknown'` — both first-class, not shoehorned into `'update'`. `pendingOperationIdempotencyKey` is the stable key already on the `pending_operations` row — reused (with an `:audit` suffix) rather than re-derived, so this works identically whether called from a live command or from `recoverPending()`. */
  private async recordModerationAction(action: ModerationAction, input: ModerationActionInput, pendingOperationIdempotencyKey: string, outcome: AttemptOutcome): Promise<{ readonly status: 'recorded' } | { readonly status: 'policy_skipped' }> {
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
          // HIGH (round-2): BOTS-9 events must carry the canonical module
          // identifier explicitly — never derived from whatever fields a
          // snapshot happens to contain — so BOTS-8 module-level policies
          // actually apply.
          moduleId: MODULE_IDS.moderation,
        },
        () => {
          const outcomeResult = outcome.result;
          const partialOutcome = outcomeResult?.partialOutcome === 'banned_not_kicked' ? 'banned_not_kicked' : undefined;
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
                : partialOutcome !== undefined
                  ? // HIGH-8: a confirmed-failed kick whose ban half already
                    // landed is NOT the same as "nothing happened" — surface
                    // that directly in `after`, not just buried in
                    // metadata.result where it's easy to miss.
                    observed({ chatId: input.chatId, targetUserId: input.targetUserId, actorUserId: input.actorUserId, action, partialOutcome })
                  : notApplicable(),
          });
          const mutationResult = safeDownstreamMutationResult(record, { chatId: input.chatId, targetUserId: input.targetUserId, actorUserId: input.actorUserId, action });
          return Promise.resolve({ ...mutationResult, metadata: { operation, ...(outcome.result !== undefined ? { result: outcome.result } : {}) } });
        },
      );
      return { status: 'recorded' };
    } catch (error) {
      if (error instanceof AuditPolicyDisabledError) {
        this.logger.info({ event: 'audit.moderation_action.policy_skipped', chatId: input.chatId, details: { action } });
        return { status: 'policy_skipped' };
      }
      // BLOCKER-1/4: infrastructure failure — do NOT swallow. The outbox
      // keeps `audit_status='pending'` and the caller fails the update
      // chain so the mandatory record eventually lands.
      this.logger.warn({ event: 'audit.moderation_action.failed', chatId: input.chatId, details: { action }, error: normalizeError(error) });
      throw error;
    }
  }
}

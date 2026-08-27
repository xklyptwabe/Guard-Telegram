import type { Context } from 'grammy';

import { MODULE_IDS } from '../../constants.js';
import { AuditPolicyDisabledError, type AuditService } from '../auditService.js';
import { getUpdateContext } from '../context.js';
import type { Logger } from '../logger.js';
import { normalizeError } from '../logger.js';
import { AuditFinalizationPendingError } from '../moderation/pendingOperationsOutbox.js';
import { AuditEventProcessor } from './eventProcessor.js';
import type { RaiseAuditEventInput } from './eventProcessor.js';
import { readCurrentSnapshotData } from './entitySnapshotLookup.js';
import { observed, notObserved, notApplicable } from './snapshot.js';
import { auditEventStatusForOperation, toDownstreamMutationResult } from './serviceAdapter.js';
import { safeDownstreamMutationResult } from './mutationResult.js';

const auditProcessor = new AuditEventProcessor();

/**
 * ============================================================================
 * BOTS-9: what this module does and does not claim to support
 * ============================================================================
 * The Telegram Bot API has no `deleted_message` update and no endpoint to
 * fetch a message that no longer exists. Concretely, this means:
 *
 *  - A message someone deletes through their own Telegram client (or an
 *    admin deletes through the Telegram UI) is invisible to the bot. There
 *    is nothing to subscribe to, poll, or infer it from short of guessing
 *    from a gap in message IDs — which this module deliberately does not
 *    do, because a guess is not an observation.
 *  - The only deletion this module ever audits is one the *bot itself*
 *    performs via `deleteMessage` (see `ModerationService.deleteMessage`,
 *    driven by an admin command) — because that is the one case where the
 *    bot has first-hand knowledge that a deletion happened.
 *
 * `recordMessageDeleted` below must only ever be called from that one
 * place. There is intentionally no Telegram update handler for "message
 * deleted" anywhere in this codebase.
 *
 * Every `message.edited` this module records still only carries text if
 * `allowMessageTextLogging` is actually enabled for the chat — see the
 * `policy` note on `raiseTextCapableEvent` below.
 * ============================================================================
 */

/**
 * `message.edited`/`message.deleted` are the only two BOTS-7 events with a
 * conditional field (`text`, gated on `policy.allowMessageTextLogging`).
 * `AuditEventProcessor.process()` defaults to `{allowMessageTextLogging:
 * false}` when no `policy` is given — appropriate for every other event,
 * but wrong here: it would permanently strip `text` before it ever reaches
 * `AuditService.recordEntityChange`'s *own* masking pass, which is the one
 * that actually knows this chat's real, resolved policy. Passing a
 * permissive policy at this (BOTS-7) layer keeps `text` alive long enough
 * for that real, authoritative pass to decide — it is still the only place
 * that can actually cause `text` to be persisted.
 */
const TEXT_CAPABLE_POLICY = { allowMessageTextLogging: true };

function raiseTextCapableEvent(input: Omit<RaiseAuditEventInput<'message.edited' | 'message.deleted'>, 'policy'>) {
  return auditProcessor.process({ ...input, policy: TEXT_CAPABLE_POLICY });
}

/**
 * Stores the latest policy-allowed state observed in ordinary `message` and
 * `channel_post` updates. This does not create a synthetic message event; it
 * only gives a later edit or observed bot-side deletion a real `before`.
 */
export async function recordMessageObserved(audit: AuditService, logger: Logger, ctx: Context): Promise<void> {
  const message = ctx.message ?? ctx.channelPost;
  if (!message) return;
  const userId = message.from ? String(message.from.id) : undefined;
  const updateContext = getUpdateContext();
  if (!updateContext) return;
  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);
  const text = message.text ?? message.caption;
  const observedAt = new Date(message.date * 1000).toISOString();
  const rawIncomingUpdateId = Number(updateContext.updateId);
  const incomingUpdateId = Number.isFinite(rawIncomingUpdateId) ? rawIncomingUpdateId : 0;
  try {
    await audit.observeCurrentSnapshot({
      tenantId: chatId,
      subjectType: 'message',
      subjectId: `${chatId}:${messageId}`,
      eventType: 'message.edited',
      eventVersion: 'v1',
      moduleId: MODULE_IDS.messageAudit,
      snapshotData: {
        chatId,
        messageId,
        ...(userId !== undefined ? { userId } : {}),
        editedAt: observedAt,
        observedUpdateId: incomingUpdateId,
        textLength: text?.length ?? 0,
        ...(text !== undefined ? { text } : {}),
      },
      observedUpdateId: incomingUpdateId,
    });
  } catch (error) {
    logger.warn({ event: 'audit.message_observed.failed', chatId, details: { messageId }, error: normalizeError(error) });
    throw new AuditFinalizationPendingError(`message observation snapshot for ${chatId}:${messageId} is still owed`);
  }
}

export async function recordMessageEdited(audit: AuditService, logger: Logger, ctx: Context): Promise<void> {
  const message = ctx.editedMessage ?? ctx.editedChannelPost;
  if (!message) return;
  if (message.edit_date === undefined) {
    logger.warn({ event: 'audit.message_edited.incomplete_update', details: { hasMessage: true } });
    return;
  }

  const chatId = String(message.chat.id);
  const messageId = String(message.message_id);
  const userId = message.from ? String(message.from.id) : undefined;

  const updateContext = getUpdateContext();
  if (!updateContext) {
    logger.warn({ event: 'audit.message_edited.missing_update_context', chatId, details: { messageId } });
    return;
  }

  const text = message.text ?? message.caption;
  const editedAt = new Date(message.edit_date * 1000).toISOString();
  const source = ctx.editedChannelPost ? 'telegram.edited_channel_post_update' : 'telegram.edited_message_update';
  const idempotencyKey = `message.edited:telegram-update:${updateContext.botId ?? 'unscoped-bot'}:${updateContext.updateId}:${chatId}:${messageId}`;
  const subjectType = 'message';
  const subjectId = `${chatId}:${messageId}`;

  try {
    await audit.recordEntityChange(
      {
        tenantId: chatId,
        subjectType,
        subjectId,
        eventType: 'message.edited',
        eventVersion: 'v1',
        category: 'message',
        source,
        idempotencyKey,
        ...(userId !== undefined ? { actorId: userId, actorType: 'telegram_user' } : {}),
        // Round-2 (HIGH): canonical module id so BOTS-8 module policy applies.
        moduleId: MODULE_IDS.messageAudit,
      },
      async (tx) => {
        // The "last allowed version" requirement: whatever was recorded
        // for this message before (if anything) is the `before` here —
        // never fabricated, `not_observed` when this is the first time
        // this message has ever been seen.
        const previous = await readCurrentSnapshotData(tx, chatId, subjectType, subjectId);

        // BOTS-9 review finding (HIGH-1, residual): Telegram updates are
        // not guaranteed to arrive in order. A genuinely *different*, older
        // edit (different update_id, so the idempotency key does not catch
        // it) must never regress the current snapshot — same isStale guard
        // as memberAudit/botMembershipAudit, keyed on the snapshot's own
        // editedAt instead of observedAt. A stale edit is still audited
        // (complete history) but as a noop that leaves the snapshot alone.
        // Round-2 (HIGH): edit_date has second precision — an EQUAL
        // timestamp must not let a second update overwrite either, so the
        // update_id is the tie-breaker order marker (Telegram's update_id
        // is strictly increasing per bot).
        const previousEditedAt = typeof previous?.editedAt === 'string' ? previous.editedAt : undefined;
        const previousUpdateId = typeof previous?.observedUpdateId === 'number' ? previous.observedUpdateId : undefined;
        const rawIncomingUpdateId = updateContext.updateId !== undefined ? Number(updateContext.updateId) : 0;
        const incomingUpdateId = Number.isFinite(rawIncomingUpdateId) ? rawIncomingUpdateId : 0;
        const isStale =
          previousEditedAt !== undefined &&
          (previousEditedAt > editedAt || (previousEditedAt === editedAt && (previousUpdateId ?? 0) >= incomingUpdateId));
        const incomingAfter = {
          chatId,
          messageId,
          ...(userId !== undefined ? { userId } : {}),
          editedAt,
          observedUpdateId: incomingUpdateId,
          textLength: text?.length ?? 0,
          ...(text !== undefined ? { text } : {}),
        };
        const operation = isStale ? 'noop' : previous ? 'update' : 'create';

        const record = raiseTextCapableEvent({
          name: 'message.edited',
          version: 1,
          operation,
          chatId,
          ...(userId !== undefined ? { actorId: userId } : {}),
          before: previous ? observed(previous) : notObserved(),
          after: observed(incomingAfter),
        });
        const mutationResult = toDownstreamMutationResult(record);

        return {
          ...mutationResult,
          metadata: { operation, ...(isStale ? { outOfOrder: true } : {}) },
          snapshotData: isStale && previous ? previous : incomingAfter,
        };
      },
    );
  } catch (error) {
    if (error instanceof AuditPolicyDisabledError) {
      logger.info({ event: 'audit.message_edited.policy_skipped', chatId, details: { messageId } });
      return;
    }
    logger.warn({ event: 'audit.message_edited.failed', chatId, details: { messageId }, error: normalizeError(error) });
    throw new AuditFinalizationPendingError(`message.edited audit for ${chatId}:${messageId} is still owed`);
  }
}

/**
 * BOTS-9: audits a deletion the bot itself just performed via
 * `deleteMessage` as `message.deleted`. See the module doc comment above —
 * this must never be called for a deletion the bot merely infers or is told
 * about after the fact; only for one it directly executed.
 */
export interface RecordMessageDeletedInput {
  readonly chatId: string;
  readonly messageId: string;
  /**
   * Caller-supplied idempotency key — normally derived from the triggering
   * Update, but recovery-after-restart has no live Update to ask, only the
   * stable key already written ahead on the `pending_operations` row. See
   * `ModerationService.deleteMessage`/`recoverPending`.
   */
  readonly idempotencyKey: string;
  /** Who triggered the deletion (the moderator, or the bot acting on an automated policy). */
  readonly deletedBy?: string;
  /**
   * The message's own author, if known *at the moment of deletion* — e.g.
   * from `ctx.message.reply_to_message.from` when an admin deletes by
   * replying to the message. Falls back to whatever was last observed for
   * this message (an earlier edit); if neither is available, `before` is
   * `not_observed` and no author is recorded at all.
   */
  readonly knownAuthorUserId?: string;
  /** Defaults to 'succeeded' for backward-compat call sites; ModerationService.deleteMessage passes the real outcome explicitly so failed/unknown attempts are audited too, not silently dropped. */
  readonly outcome?: 'succeeded' | 'failed' | 'unknown';
}

/**
 * BOTS-9: audits a deletion the bot itself just performed via
 * `deleteMessage` as `message.deleted`. See the module doc comment above —
 * this must never be called for a deletion the bot merely infers or is told
 * about after the fact; only for one it directly executed.
 */
export async function recordMessageDeleted(
  audit: AuditService,
  logger: Logger,
  input: RecordMessageDeletedInput,
): Promise<{ readonly status: 'recorded' } | { readonly status: 'policy_skipped' }> {
  const subjectType = 'message';
  const subjectId = `${input.chatId}:${input.messageId}`;
  const outcome = input.outcome ?? 'succeeded';
  // BOTS-9 review finding (BLOCKER-1): this used to hardcode operation:
  // 'delete' and was only ever called on a confirmed success — a
  // confirmed-failed or exhausted-unknown deleteMessage attempt produced
  // no audit record at all, the same class of bug as moderation.action's
  // missing terminal record. `outcome` now drives the real operation.
  const operation = outcome === 'succeeded' ? ('delete' as const) : outcome;

  try {
    await audit.recordEntityChange(
      {
        tenantId: input.chatId,
        subjectType,
        subjectId,
        eventType: 'message.deleted',
        eventVersion: 'v1',
        category: 'message',
        source: 'telegram.moderation_delete',
        idempotencyKey: input.idempotencyKey,
        status: auditEventStatusForOperation(operation),
        ...(input.deletedBy !== undefined ? { actorId: input.deletedBy, actorType: 'telegram_user' } : {}),
        // Round-2 (HIGH): the bot's own deleteMessage is a moderation
        // action — canonical module id for BOTS-8 module policy.
        moduleId: MODULE_IDS.moderation,
      },
      async (tx) => {
        const previous = await readCurrentSnapshotData(tx, input.chatId, subjectType, subjectId);
        const previousUserId = typeof previous?.userId === 'string' ? previous.userId : undefined;
        const userId = input.knownAuthorUserId ?? previousUserId;

        const record = raiseTextCapableEvent({
          name: 'message.deleted',
          version: 1,
          operation,
          chatId: input.chatId,
          ...(input.deletedBy !== undefined ? { actorId: input.deletedBy } : {}),
          // A failed/unknown delete attempt means the message likely still
          // exists (or we genuinely don't know) — either way we have no
          // fresh content to report, same as a confirmed delete: the Bot
          // API never gives us anything to re-fetch.
          before: previous ? observed(previous) : notObserved(),
          after: notApplicable(),
        });

        if (outcome === 'succeeded') {
          // Deliberately not `toDownstreamMutationResult(record)` here: that
          // helper throws `MissingAuditSnapshotDataError` when `after` is
          // `not_applicable` *and* `before` is also non-observed — exactly
          // the legitimate "deleted a message we never saw before" case this
          // producer exists to handle gracefully (`before_status =
          // not_observed`). See `mutationResult.ts`.
          const mutationResult = safeDownstreamMutationResult(record, { chatId: input.chatId, messageId: input.messageId, deleted: true });
          return { ...mutationResult, metadata: { operation: record.operation, ...(userId !== undefined ? { userId } : {}) } };
        }

        // Round-2 (HIGH-3): a failed/unknown delete must NOT archive the
        // snapshot — Telegram never confirmed the deletion, so the message
        // likely still exists and the DB must keep saying so. The audit
        // event still records the attempt, but the entity snapshot stays
        // exactly as it was. If there was no snapshot, keep SQL NULL: before
        // remains not_observed and no JSON state is fabricated.
        // `before` is the RAW snapshot data (the `observed(...)` wrapper is
        // only used inside AuditRecord; `normalizeAuditMutationForPersistence`
        // expects the plain data alongside `beforeSnapshotStatus`).
        return {
          before: previous,
          after: undefined,
          beforeSnapshotStatus: record.before.status,
          afterSnapshotStatus: record.after.status,
          changes: record.changes,
          snapshotStatus: 'current',
          snapshotData: previous ?? null,
          metadata: { operation: record.operation, ...(userId !== undefined ? { userId } : {}) },
        };
      },
    );
    return { status: 'recorded' };
  } catch (error) {
    if (error instanceof AuditPolicyDisabledError) {
      logger.info({ event: 'audit.message_deleted.policy_skipped', chatId: input.chatId, details: { messageId: input.messageId } });
      return { status: 'policy_skipped' };
    }
    // BLOCKER-1/4: infrastructure failure — do NOT swallow; the outbox
    // keeps `audit_status='pending'` and the caller fails the update chain.
    logger.warn({ event: 'audit.message_deleted.failed', chatId: input.chatId, details: { messageId: input.messageId }, error: normalizeError(error) });
    throw error;
  }
}

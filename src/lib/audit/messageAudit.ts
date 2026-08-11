import type { Context } from 'grammy';

import type { AuditService } from '../auditService.js';
import { getUpdateContext } from '../context.js';
import type { Logger } from '../logger.js';
import { normalizeError } from '../logger.js';
import { AuditEventProcessor } from './eventProcessor.js';
import type { RaiseAuditEventInput } from './eventProcessor.js';
import { readCurrentSnapshotData } from './entitySnapshotLookup.js';
import { observed, notObserved, notApplicable } from './snapshot.js';
import { toDownstreamMutationResult } from './serviceAdapter.js';
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

/** BOTS-9: audits Telegram's `edited_message`/`edited_channel_post` update as `message.edited`. Requires `edited_message` in `TELEGRAM_ALLOWED_UPDATES`. */
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
  if (userId === undefined) {
    // Anonymous admin posts and channel posts have no `from` — we cannot
    // satisfy `messageEditedSchema.userId` (always required, unlike the
    // deletion schema) without fabricating one.
    logger.warn({ event: 'audit.message_edited.no_author', chatId, details: { messageId } });
    return;
  }

  const updateContext = getUpdateContext();
  if (!updateContext) {
    logger.warn({ event: 'audit.message_edited.missing_update_context', chatId, details: { messageId } });
    return;
  }

  const text = message.text ?? message.caption;
  const editedAt = new Date(message.edit_date * 1000).toISOString();
  const idempotencyKey = `message.edited:telegram-update:${updateContext.updateId}:${chatId}:${messageId}`;
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
        source: 'telegram.edited_message_update',
        idempotencyKey,
        actorId: userId,
        actorType: 'telegram_user',
      },
      async (tx) => {
        // The "last allowed version" requirement: whatever was recorded
        // for this message before (if anything) is the `before` here —
        // never fabricated, `not_observed` when this is the first time
        // this message has ever been seen.
        const previous = await readCurrentSnapshotData(tx, chatId, subjectType, subjectId);

        const record = raiseTextCapableEvent({
          name: 'message.edited',
          version: 1,
          operation: previous ? 'update' : 'create',
          chatId,
          actorId: userId,
          before: previous ? observed(previous) : notObserved(),
          after: observed({ chatId, messageId, userId, editedAt, textLength: text?.length ?? 0, ...(text !== undefined ? { text } : {}) }),
        });
        const mutationResult = toDownstreamMutationResult(record);

        return { ...mutationResult, metadata: { operation: record.operation } };
      },
    );
  } catch (error) {
    logger.warn({ event: 'audit.message_edited.failed', chatId, details: { messageId }, error: normalizeError(error) });
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
}

/**
 * BOTS-9: audits a deletion the bot itself just performed via
 * `deleteMessage` as `message.deleted`. See the module doc comment above —
 * this must never be called for a deletion the bot merely infers or is told
 * about after the fact; only for one it directly executed.
 */
export async function recordMessageDeleted(audit: AuditService, logger: Logger, input: RecordMessageDeletedInput): Promise<void> {
  const subjectType = 'message';
  const subjectId = `${input.chatId}:${input.messageId}`;

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
        ...(input.deletedBy !== undefined ? { actorId: input.deletedBy, actorType: 'telegram_user' } : {}),
      },
      async (tx) => {
        const previous = await readCurrentSnapshotData(tx, input.chatId, subjectType, subjectId);
        const previousUserId = typeof previous?.userId === 'string' ? previous.userId : undefined;
        const userId = input.knownAuthorUserId ?? previousUserId;

        const record = raiseTextCapableEvent({
          name: 'message.deleted',
          version: 1,
          operation: 'delete',
          chatId: input.chatId,
          ...(input.deletedBy !== undefined ? { actorId: input.deletedBy } : {}),
          before: previous ? observed(previous) : notObserved(),
          after: notApplicable(),
        });

        // Deliberately not `toDownstreamMutationResult(record)` here: that
        // helper throws `MissingAuditSnapshotDataError` when `after` is
        // `not_applicable` *and* `before` is also non-observed — exactly
        // the legitimate "deleted a message we never saw before" case this
        // producer exists to handle gracefully (`before_status =
        // not_observed`). See `mutationResult.ts`.
        const mutationResult = safeDownstreamMutationResult(record, { chatId: input.chatId, messageId: input.messageId, deleted: true });
        return { ...mutationResult, metadata: { operation: record.operation, ...(userId !== undefined ? { userId } : {}) } };
      },
    );
  } catch (error) {
    logger.warn({ event: 'audit.message_deleted.failed', chatId: input.chatId, details: { messageId: input.messageId }, error: normalizeError(error) });
  }
}

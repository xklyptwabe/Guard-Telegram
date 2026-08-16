import type { Context } from 'grammy';

import type { AuditService } from '../auditService.js';
import { getUpdateContext } from '../context.js';
import type { Logger } from '../logger.js';
import { normalizeError } from '../logger.js';
import { AuditEventProcessor } from './eventProcessor.js';
import { readCurrentSnapshotData } from './entitySnapshotLookup.js';
import { memberStatusSchema } from './shapes.js';
import { observed, notObserved } from './snapshot.js';
import { toDownstreamMutationResult } from './serviceAdapter.js';

const auditProcessor = new AuditEventProcessor();

interface MemberSnapshotData {
  readonly status: string;
  /** Telegram's own `date` (unix seconds) for the update that produced this status — used to detect out-of-order redelivery. */
  readonly observedAt: string;
}

/**
 * BOTS-9: audits Telegram's `chat_member` update as `member.status.changed`,
 * built from the update's *real* `old_chat_member`/`new_chat_member` (never
 * synthesized). Requires `chat_member` to be present in
 * `TELEGRAM_ALLOWED_UPDATES` — see `src/config.ts`.
 *
 * Handles two BOTS-9 requirements explicitly:
 *  - INCOMPLETE UPDATES: if `new_chat_member`/its `user`/`status` is
 *    missing or not one of Telegram's known statuses, this logs a warning
 *    and returns without throwing — never fabricates a status.
 *  - OUT-OF-ORDER UPDATES: compares the incoming update's `date` against
 *    the `observedAt` already recorded for this subject. An update that is
 *    older than what's already on file is still audited (for a complete
 *    history) but is never allowed to regress the "current" snapshot —
 *    `chat_member` updates are not guaranteed to arrive in order.
 */
export async function recordMemberStatusChanged(audit: AuditService, logger: Logger, ctx: Context): Promise<void> {
  const update = ctx.chatMember;
  if (!update) return;

  const chatId = String(update.chat.id);
  const newStatusParsed = memberStatusSchema.safeParse(update.new_chat_member?.status);
  const userId = update.new_chat_member?.user?.id !== undefined ? String(update.new_chat_member.user.id) : undefined;
  if (!newStatusParsed.success || userId === undefined) {
    logger.warn({ event: 'audit.member_status_changed.incomplete_update', chatId, details: { hasNewChatMember: update.new_chat_member !== undefined } });
    return;
  }

  const updateContext = getUpdateContext();
  if (!updateContext) {
    logger.warn({ event: 'audit.member_status_changed.missing_update_context', chatId });
    return;
  }

  const oldStatusParsed = memberStatusSchema.safeParse(update.old_chat_member?.status);
  const actorId = update.from ? String(update.from.id) : undefined;
  const observedAt = new Date(update.date * 1000).toISOString();
  const idempotencyKey = `member.status.changed:telegram-update:${updateContext.botId ?? 'unscoped-bot'}:${updateContext.updateId}:${chatId}:${userId}`;
  const subjectType = 'chat_member';
  const subjectId = `${chatId}:${userId}`;

  try {
    await audit.recordEntityChange(
      {
        tenantId: chatId,
        subjectType,
        subjectId,
        eventType: 'member.status.changed',
        eventVersion: 'v1',
        category: 'member',
        source: 'telegram.chat_member_update',
        idempotencyKey,
        ...(actorId !== undefined ? { actorId, actorType: 'telegram_user' } : {}),
      },
      async (tx) => {
        const current = (await readCurrentSnapshotData(tx, chatId, subjectType, subjectId)) as Partial<MemberSnapshotData> | undefined;
        const isStale = current?.observedAt !== undefined && current.observedAt > observedAt;

        const afterStatus = isStale && current?.status !== undefined ? current.status : newStatusParsed.data;
        const effectiveObservedAt = isStale && current?.observedAt !== undefined ? current.observedAt : observedAt;
        const operation = isStale ? 'noop' : oldStatusParsed.success && oldStatusParsed.data === afterStatus ? 'noop' : 'update';

        const record = auditProcessor.process({
          name: 'member.status.changed',
          version: 1,
          operation,
          chatId,
          ...(actorId !== undefined ? { actorId } : {}),
          before: oldStatusParsed.success ? observed({ chatId, userId, status: oldStatusParsed.data }) : notObserved(),
          after: observed({ chatId, userId, status: afterStatus }),
        });
        const mutationResult = toDownstreamMutationResult(record);

        return {
          ...mutationResult,
          metadata: { operation, ...(isStale ? { outOfOrder: true } : {}) },
          snapshotStatus: mutationResult.snapshotStatus,
          snapshotData: { ...mutationResult.snapshotData, observedAt: effectiveObservedAt },
        };
      },
    );
  } catch (error) {
    logger.warn({ event: 'audit.member_status_changed.failed', chatId, error: normalizeError(error) });
  }
}

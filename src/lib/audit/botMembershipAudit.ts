import type { Context } from 'grammy';

import type { AuditService } from '../auditService.js';
import { getUpdateContext } from '../context.js';
import type { Logger } from '../logger.js';
import { normalizeError } from '../logger.js';
import { AuditEventProcessor } from './eventProcessor.js';
import { readCurrentSnapshotData } from './entitySnapshotLookup.js';
import { botMembershipChangedSchema } from './shapes.js';
import { observed, notObserved } from './snapshot.js';
import { toDownstreamMutationResult } from './serviceAdapter.js';

const auditProcessor = new AuditEventProcessor();

/**
 * BOTS-9: audits Telegram's `my_chat_member` update — the bot's *own*
 * membership/rights changing in a chat — as `bot.membership.changed`.
 * Deliberately always called directly from platform-level wiring
 * (`core/updates.ts`), never registered as a per-module `updateHandler`:
 * this event's definition marks `canBeDisabled: false` (see
 * `definitions.ts`) precisely because whether the bot itself can still act
 * in a chat is not an optional feature any chat admin should be able to
 * silence by disabling a module.
 */
export async function recordBotMembershipChanged(audit: AuditService, logger: Logger, ctx: Context): Promise<void> {
  const update = ctx.myChatMember;
  if (!update) return;

  const chatId = String(update.chat.id);
  const newStatusParsed = botMembershipChangedSchema.shape.status.safeParse(update.new_chat_member?.status);
  if (!newStatusParsed.success) {
    // Telegram's ChatMember union also includes 'creator'/'restricted',
    // neither of which a bot account can hold — an unexpected status here
    // means Telegram sent something this schema doesn't model. Log and
    // skip rather than fabricate or crash.
    logger.warn({ event: 'audit.bot_membership_changed.incomplete_update', chatId, details: { rawStatus: update.new_chat_member?.status } });
    return;
  }

  const updateContext = getUpdateContext();
  if (!updateContext) {
    logger.warn({ event: 'audit.bot_membership_changed.missing_update_context', chatId });
    return;
  }

  const oldStatusParsed = botMembershipChangedSchema.shape.status.safeParse(update.old_chat_member?.status);
  const actorId = update.from ? String(update.from.id) : undefined;
  const observedAt = new Date(update.date * 1000).toISOString();
  const idempotencyKey = `bot.membership.changed:telegram-update:${updateContext.updateId}:${chatId}`;
  const subjectType = 'bot_membership';
  const subjectId = chatId;

  try {
    await audit.recordEntityChange(
      {
        tenantId: chatId,
        subjectType,
        subjectId,
        eventType: 'bot.membership.changed',
        eventVersion: 'v1',
        category: 'bot',
        source: 'telegram.my_chat_member_update',
        idempotencyKey,
        ...(actorId !== undefined ? { actorId, actorType: 'telegram_user' } : {}),
      },
      async (tx) => {
        const current = (await readCurrentSnapshotData(tx, chatId, subjectType, subjectId)) as { status?: string; observedAt?: string } | undefined;
        const isStale = current?.observedAt !== undefined && current.observedAt > observedAt;

        const afterStatus = isStale && current?.status !== undefined ? current.status : newStatusParsed.data;
        const effectiveObservedAt = isStale && current?.observedAt !== undefined ? current.observedAt : observedAt;
        const operation = isStale ? 'noop' : oldStatusParsed.success && oldStatusParsed.data === afterStatus ? 'noop' : 'update';

        const record = auditProcessor.process({
          name: 'bot.membership.changed',
          version: 1,
          operation,
          chatId,
          ...(actorId !== undefined ? { actorId } : {}),
          before: oldStatusParsed.success ? observed({ chatId, status: oldStatusParsed.data }) : notObserved(),
          after: observed({ chatId, status: afterStatus }),
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
    logger.warn({ event: 'audit.bot_membership_changed.failed', chatId, error: normalizeError(error) });
  }
}

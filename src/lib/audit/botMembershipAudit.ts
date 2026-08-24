import type { Context } from 'grammy';

import { AuditPolicyDisabledError, type AuditService } from '../auditService.js';
import { getUpdateContext } from '../context.js';
import type { Logger } from '../logger.js';
import { normalizeError } from '../logger.js';
import { AuditFinalizationPendingError } from '../moderation/pendingOperationsOutbox.js';
import { AuditEventProcessor } from './eventProcessor.js';
import { readCurrentSnapshotData } from './entitySnapshotLookup.js';
import { botAdministratorRightsSchema, botMembershipChangedSchema, type BotAdministratorRights } from './shapes.js';
import { observed, notObserved } from './snapshot.js';
import { toDownstreamMutationResult } from './serviceAdapter.js';

const auditProcessor = new AuditEventProcessor();

/** Only the fields Telegram's `ChatMemberAdministrator` carries that this schema tracks — see `botAdministratorRightsSchema`'s doc comment. */
interface RawChatMember {
  readonly status?: string;
  readonly is_anonymous?: boolean;
  readonly can_manage_chat?: boolean;
  readonly can_delete_messages?: boolean;
  readonly can_manage_video_chats?: boolean;
  readonly can_restrict_members?: boolean;
  readonly can_promote_members?: boolean;
  readonly can_change_info?: boolean;
  readonly can_invite_users?: boolean;
  readonly can_pin_messages?: boolean;
  readonly can_manage_topics?: boolean;
  readonly can_post_stories?: boolean;
  readonly can_edit_stories?: boolean;
  readonly can_delete_stories?: boolean;
  readonly can_post_messages?: boolean;
  readonly can_edit_messages?: boolean;
  readonly can_manage_direct_messages?: boolean;
  readonly can_manage_tags?: boolean;
}

/** BOTS-9 review fix (HIGH-2): extracts the bot's own admin rights when it holds them — undefined for any non-administrator status, matching the schema's `rights` field being optional. Round-2 (HIGH-4): full `ChatMemberAdministrator` coverage — each optional field is only included when Telegram actually sent it. */
function extractRights(member: RawChatMember | undefined): BotAdministratorRights | undefined {
  if (!member || member.status !== 'administrator') return undefined;
  const parsed = botAdministratorRightsSchema.safeParse({
    canManageChat: member.can_manage_chat,
    canDeleteMessages: member.can_delete_messages,
    canManageVideoChats: member.can_manage_video_chats,
    canRestrictMembers: member.can_restrict_members,
    canPromoteMembers: member.can_promote_members,
    canChangeInfo: member.can_change_info,
    canInviteUsers: member.can_invite_users,
    ...(member.can_pin_messages !== undefined ? { canPinMessages: member.can_pin_messages } : {}),
    ...(member.can_manage_topics !== undefined ? { canManageTopics: member.can_manage_topics } : {}),
    ...(member.is_anonymous !== undefined ? { isAnonymous: member.is_anonymous } : {}),
    ...(member.can_post_stories !== undefined ? { canPostStories: member.can_post_stories } : {}),
    ...(member.can_edit_stories !== undefined ? { canEditStories: member.can_edit_stories } : {}),
    ...(member.can_delete_stories !== undefined ? { canDeleteStories: member.can_delete_stories } : {}),
    ...(member.can_post_messages !== undefined ? { canPostMessages: member.can_post_messages } : {}),
    ...(member.can_edit_messages !== undefined ? { canEditMessages: member.can_edit_messages } : {}),
    ...(member.can_manage_direct_messages !== undefined ? { canManageDirectMessages: member.can_manage_direct_messages } : {}),
    ...(member.can_manage_tags !== undefined ? { canManageTags: member.can_manage_tags } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** Deliberately not a generic deep-equal: `BotAdministratorRights` is always built by `extractRights` above with the same fixed key set/order, so a stringify comparison is exact and cheap here — this is not meant to generalize beyond this one shape. */
function rightsEqual(a: BotAdministratorRights | undefined, b: BotAdministratorRights | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * BOTS-9: audits Telegram's `my_chat_member` update — the bot's *own*
 * membership/rights changing in a chat — as `bot.membership.changed`.
 * Deliberately always called directly from platform-level wiring
 * (`core/updates.ts`), never registered as a per-module `updateHandler`:
 * this event's definition marks `canBeDisabled: false` (see
 * `definitions.ts`) precisely because whether the bot itself can still act
 * in a chat is not an optional feature any chat admin should be able to
 * silence by disabling a module.
 *
 * Tracks admin *rights*, not just `status` (BOTS-9 review HIGH-2): a chat
 * owner revoking `can_restrict_members` from an already-administrator bot
 * — silently disabling its ability to moderate — previously produced an
 * identical before/after (`status: 'administrator'` both times) and was
 * recorded as a no-op. That is exactly the kind of safety-critical change
 * this event exists to catch.
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
  const newRights = extractRights(update.new_chat_member);
  const oldRights = extractRights(update.old_chat_member);
  const actorId = update.from ? String(update.from.id) : undefined;
  const observedAt = new Date(update.date * 1000).toISOString();
  const idempotencyKey = `bot.membership.changed:telegram-update:${updateContext.botId ?? 'unscoped-bot'}:${updateContext.updateId}:${chatId}`;
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
        const current = (await readCurrentSnapshotData(tx, chatId, subjectType, subjectId)) as { status?: string; rights?: BotAdministratorRights; observedAt?: string; observedUpdateId?: number } | undefined;
        // Round-2 (HIGH): update.date has second precision — two updates in
        // the same second are common (ban+unban), and a plain `>` lets the
        // second one overwrite the first as if newer. Telegram's update_id
        // is strictly increasing, so it is the tie-breaker; if the order is
        // genuinely undecidable the snapshot is NOT overwritten.
        const rawIncomingUpdateId = updateContext.updateId !== undefined ? Number(updateContext.updateId) : 0;
        const incomingUpdateId = Number.isFinite(rawIncomingUpdateId) ? rawIncomingUpdateId : 0;
        const isStale =
          current?.observedAt !== undefined &&
          (current.observedAt > observedAt || (current.observedAt === observedAt && (current.observedUpdateId ?? 0) >= incomingUpdateId));

        const snapshotStatus = isStale && current?.status !== undefined ? current.status : newStatusParsed.data;
        const snapshotRights = isStale ? current?.rights : newRights;
        const effectiveObservedAt = isStale && current?.observedAt !== undefined ? current.observedAt : observedAt;
        const effectiveObservedUpdateId = isStale ? (current?.observedUpdateId ?? incomingUpdateId) : incomingUpdateId;
        const statusChanged = oldStatusParsed.success ? oldStatusParsed.data !== newStatusParsed.data : true;
        const rightsChanged = !rightsEqual(oldRights, newRights);
        const operation = isStale ? 'noop' : statusChanged || rightsChanged ? 'update' : 'noop';

        const record = auditProcessor.process({
          name: 'bot.membership.changed',
          version: 1,
          operation,
          chatId,
          ...(actorId !== undefined ? { actorId } : {}),
          before: oldStatusParsed.success ? observed({ chatId, status: oldStatusParsed.data, ...(oldRights ? { rights: oldRights } : {}) }) : notObserved(),
          after: observed({ chatId, status: newStatusParsed.data, ...(newRights ? { rights: newRights } : {}) }),
        });
        const mutationResult = toDownstreamMutationResult(record);

        return {
          ...mutationResult,
          metadata: { operation, ...(isStale ? { outOfOrder: true } : {}) },
          snapshotStatus: mutationResult.snapshotStatus,
          snapshotData: {
            chatId,
            status: snapshotStatus,
            ...(snapshotRights ? { rights: snapshotRights } : {}),
            observedAt: effectiveObservedAt,
            observedUpdateId: effectiveObservedUpdateId,
          },
        };
      },
    );
  } catch (error) {
    if (error instanceof AuditPolicyDisabledError) {
      logger.info({ event: 'audit.bot_membership_changed.policy_skipped', chatId });
      return;
    }
    logger.warn({ event: 'audit.bot_membership_changed.failed', chatId, error: normalizeError(error) });
    throw new AuditFinalizationPendingError(`bot.membership.changed audit for chat ${chatId} is still owed`);
  }
}

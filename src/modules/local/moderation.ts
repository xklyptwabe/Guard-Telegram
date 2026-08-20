import type { Context } from 'grammy';
import { z } from 'zod';

import { COMMAND_NAMES, MODULE_IDS } from '../../constants.js';
import type { CommandExecutionContext, TelegramBotModule } from '../../core/contracts.js';
import type { ModerationOutcome } from '../../lib/moderation/moderationService.js';
import type { ModerationService } from '../../lib/moderation/moderationService.js';

const freeTextArgs = z.string();

/** Telegram restrictChatMember: 30s … 366 days. Shorter values are ignored or error. */
export const RESTRICT_DURATION_MIN_SECONDS = 30;
export const RESTRICT_DURATION_MAX_SECONDS = 366 * 24 * 60 * 60;

async function rejectUnsafeTarget(context: CommandExecutionContext, target: ResolvedTarget): Promise<boolean> {
  if (target.userId === context.userId) {
    await context.reply.send(context.ctx, context.t('moderation.cannotTargetSelf'));
    return true;
  }
  const botId = context.ctx.me?.id;
  if (botId !== undefined && target.userId === String(botId)) {
    await context.reply.send(context.ctx, context.t('moderation.cannotTargetBot'));
    return true;
  }
  return false;
}

export interface ResolvedTarget {
  readonly userId: string;
  /** Whatever tokens remain in the command's arguments after the target itself was consumed — either all of it (target came from a reply) or everything after a leading numeric user_id. */
  readonly rest: readonly string[];
}

/**
 * Every moderation command accepts its target either as a reply to the
 * target's own message (the normal Telegram UX — no user_id typing
 * required) or as a leading numeric user_id (needed for `/unban`, since a
 * banned user's messages may no longer be repliable in some clients).
 */
export function resolveTarget(ctx: Context, rawArgs: string): ResolvedTarget | undefined {
  const tokens = rawArgs.trim().length > 0 ? rawArgs.trim().split(/\s+/) : [];
  const replyFrom = ctx.message?.reply_to_message?.from;
  if (replyFrom) return { userId: String(replyFrom.id), rest: tokens };
  const [first, ...rest] = tokens;
  if (first !== undefined && /^\d+$/.test(first)) return { userId: first, rest };
  return undefined;
}

async function reportOutcome(context: CommandExecutionContext, action: string, outcome: ModerationOutcome): Promise<void> {
  if (outcome.willRetry) {
    await context.reply.send(context.ctx, context.t('moderation.pending', { action }));
    return;
  }
  const key = outcome.status === 'succeeded' ? 'moderation.succeeded' : outcome.status === 'failed' ? 'moderation.failed' : 'moderation.unknown';
  await context.reply.send(context.ctx, context.t(key, { action }));
}

/**
 * BOTS-9: connects the `moderation.action` audit event (BOTS-7
 * scaffolding, no real trigger before this) to real Bot API moderation
 * calls. The bot needs to actually be a chat administrator with the
 * relevant rights for any of these to succeed — Telegram itself enforces
 * that, and a missing right surfaces here as a confirmed `GrammyError`
 * (→ `failed`), not a crash.
 */
export function createModerationModule(moderation: ModerationService): TelegramBotModule {
  return {
    id: MODULE_IDS.moderation,
    name: 'Moderation',
    description: 'Ban, unban, restrict (mute), unrestrict (unmute), kick, and delete-message commands for chat administrators.',
    global: false,
    defaultEnabled: false,
    commands: [
      {
        id: 'moderation.ban',
        name: COMMAND_NAMES.ban,
        moduleId: MODULE_IDS.moderation,
        descriptionKey: 'commands.ban',
        permission: 'chat_admin',
        cooldownMs: 500,
        argsSchema: freeTextArgs,
        async execute(context, args): Promise<void> {
          const rawArgs = freeTextArgs.parse(args);
          const target = resolveTarget(context.ctx, rawArgs);
          if (!target) {
            await context.reply.send(context.ctx, context.t('moderation.needsTarget'));
            return;
          }
          if (await rejectUnsafeTarget(context, target)) return;
          const reason = target.rest.join(' ').trim();
          const outcome = await moderation.ban({ chatId: context.chatId, targetUserId: target.userId, actorUserId: context.userId, ...(reason ? { reason } : {}) });
          await reportOutcome(context, 'ban', outcome);
        },
      },
      {
        id: 'moderation.unban',
        name: COMMAND_NAMES.unban,
        moduleId: MODULE_IDS.moderation,
        descriptionKey: 'commands.unban',
        permission: 'chat_admin',
        cooldownMs: 500,
        argsSchema: freeTextArgs,
        async execute(context, args): Promise<void> {
          const rawArgs = freeTextArgs.parse(args);
          const target = resolveTarget(context.ctx, rawArgs);
          if (!target) {
            await context.reply.send(context.ctx, context.t('moderation.needsTarget'));
            return;
          }
          if (await rejectUnsafeTarget(context, target)) return;
          const outcome = await moderation.unban({ chatId: context.chatId, targetUserId: target.userId, actorUserId: context.userId });
          await reportOutcome(context, 'unban', outcome);
        },
      },
      {
        id: 'moderation.restrict',
        name: COMMAND_NAMES.restrict,
        moduleId: MODULE_IDS.moderation,
        descriptionKey: 'commands.restrict',
        permission: 'chat_admin',
        cooldownMs: 500,
        argsSchema: freeTextArgs,
        async execute(context, args): Promise<void> {
          const rawArgs = freeTextArgs.parse(args);
          const target = resolveTarget(context.ctx, rawArgs);
          if (!target) {
            await context.reply.send(context.ctx, context.t('moderation.needsTarget'));
            return;
          }
          if (await rejectUnsafeTarget(context, target)) return;
          const [durationToken, ...reasonTokens] = target.rest;
          const durationSeconds = durationToken !== undefined ? Number(durationToken) : Number.NaN;
          if (
            !Number.isInteger(durationSeconds) ||
            durationSeconds < RESTRICT_DURATION_MIN_SECONDS ||
            durationSeconds > RESTRICT_DURATION_MAX_SECONDS
          ) {
            await context.reply.send(context.ctx, context.t('moderation.needsDuration'));
            return;
          }
          const reason = reasonTokens.join(' ').trim();
          const outcome = await moderation.restrict({ chatId: context.chatId, targetUserId: target.userId, actorUserId: context.userId, durationSeconds, ...(reason ? { reason } : {}) });
          await reportOutcome(context, 'restrict', outcome);
        },
      },
      {
        id: 'moderation.unrestrict',
        name: COMMAND_NAMES.unrestrict,
        moduleId: MODULE_IDS.moderation,
        descriptionKey: 'commands.unrestrict',
        permission: 'chat_admin',
        cooldownMs: 500,
        argsSchema: freeTextArgs,
        async execute(context, args): Promise<void> {
          const rawArgs = freeTextArgs.parse(args);
          const target = resolveTarget(context.ctx, rawArgs);
          if (!target) {
            await context.reply.send(context.ctx, context.t('moderation.needsTarget'));
            return;
          }
          if (await rejectUnsafeTarget(context, target)) return;
          const outcome = await moderation.unrestrict({ chatId: context.chatId, targetUserId: target.userId, actorUserId: context.userId });
          await reportOutcome(context, 'unrestrict', outcome);
        },
      },
      {
        id: 'moderation.kick',
        name: COMMAND_NAMES.kick,
        moduleId: MODULE_IDS.moderation,
        descriptionKey: 'commands.kick',
        permission: 'chat_admin',
        cooldownMs: 500,
        argsSchema: freeTextArgs,
        async execute(context, args): Promise<void> {
          const rawArgs = freeTextArgs.parse(args);
          const target = resolveTarget(context.ctx, rawArgs);
          if (!target) {
            await context.reply.send(context.ctx, context.t('moderation.needsTarget'));
            return;
          }
          const reason = target.rest.join(' ').trim();
          const outcome = await moderation.kick({ chatId: context.chatId, targetUserId: target.userId, actorUserId: context.userId, ...(reason ? { reason } : {}) });
          await reportOutcome(context, 'kick', outcome);
        },
      },
      {
        id: 'moderation.delete-message',
        name: 'delmsg',
        moduleId: MODULE_IDS.moderation,
        descriptionKey: 'commands.delmsg',
        permission: 'chat_admin',
        cooldownMs: 500,
        argsSchema: freeTextArgs,
        async execute(context): Promise<void> {
          const target = context.ctx.message?.reply_to_message;
          if (!target) {
            await context.reply.send(context.ctx, context.t('moderation.needsReply'));
            return;
          }
          const knownAuthorUserId = target.from ? String(target.from.id) : undefined;
          const outcome = await moderation.deleteMessage(context.chatId, String(target.message_id), context.userId, knownAuthorUserId);
          await reportOutcome(context, 'delmsg', outcome);
        },
      },
    ],
  };
}

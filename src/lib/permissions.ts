import type { Context } from 'grammy';

import type { ModulePermission } from '../core/contracts.js';

export async function hasPermission(ctx: Context, permission: ModulePermission): Promise<boolean> {
  if (permission === 'none') return true;
  if (!ctx.chat || !ctx.from) return false;
  // A private chat with the bot is not a place where Telegram admin rights
  // exist — treating it as chat_admin let anyone fire /ban /kick in DM
  // (outbox noise, false sense of moderation). Admin commands require a
  // real group/supergroup/channel membership check.
  if (ctx.chat.type === 'private') return false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === 'administrator' || member.status === 'creator';
  } catch {
    // Fail closed: a Telegram/network blip is not admin rights.
    return false;
  }
}

import type { Context } from 'grammy';

import type { ModulePermission } from '../core/contracts.js';

export async function hasPermission(ctx: Context, permission: ModulePermission): Promise<boolean> {
  if (permission === 'none') return true;
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === 'private') return true;
  const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
  return member.status === 'administrator' || member.status === 'creator';
}

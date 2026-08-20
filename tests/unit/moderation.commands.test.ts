import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';

import { createModerationModule, resolveTarget } from '../../src/modules/local/moderation.js';
import type { CommandExecutionContext, TelegramCommandDefinition } from '../../src/core/contracts.js';
import type { ModerationOutcome, ModerationService } from '../../src/lib/moderation/moderationService.js';

function fakeReplyCtx(overrides: Record<string, unknown> = {}): Context {
  return { message: undefined, ...overrides } as unknown as Context;
}

function fakeContext(overrides: Partial<CommandExecutionContext> = {}): CommandExecutionContext & { sentMessages: Array<{ key: string; options?: Record<string, unknown> }> } {
  const sentMessages: Array<{ key: string; options?: Record<string, unknown> }> = [];
  const t = (key: string, options?: Record<string, string | number>): string => {
    sentMessages.push({ key, ...(options ? { options } : {}) });
    return key;
  };
  const context = {
    ctx: fakeReplyCtx(),
    chatId: '-100111',
    userId: '9',
    moduleId: 'moderation',
    registry: {} as never,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    reply: { send: vi.fn(async () => undefined) } as never,
    events: {} as never,
    t,
    ...overrides,
  } as CommandExecutionContext;
  return Object.assign(context, { sentMessages });
}

function commandByName(name: string): TelegramCommandDefinition {
  const moderation = { ban: vi.fn(), unban: vi.fn(), restrict: vi.fn(), unrestrict: vi.fn(), kick: vi.fn(), deleteMessage: vi.fn() } as unknown as ModerationService;
  const module = createModerationModule(moderation);
  const command = module.commands?.find((c) => c.name === name);
  if (!command) throw new Error(`command ${name} not found`);
  return command;
}

describe('resolveTarget', () => {
  it('prefers a reply target over a leading numeric argument', () => {
    const ctx = fakeReplyCtx({ message: { reply_to_message: { from: { id: 42 } } } });
    expect(resolveTarget(ctx, '123 some reason')).toEqual({ userId: '42', rest: ['123', 'some', 'reason'] });
  });

  it('falls back to a leading numeric user_id when there is no reply', () => {
    const ctx = fakeReplyCtx();
    expect(resolveTarget(ctx, '555 spamming')).toEqual({ userId: '555', rest: ['spamming'] });
  });

  it('returns undefined when there is neither a reply nor a leading numeric token', () => {
    const ctx = fakeReplyCtx();
    expect(resolveTarget(ctx, 'not a number')).toBeUndefined();
    expect(resolveTarget(ctx, '')).toBeUndefined();
  });

  it('a reply target with no extra arguments has an empty rest', () => {
    const ctx = fakeReplyCtx({ message: { reply_to_message: { from: { id: 7 } } } });
    expect(resolveTarget(ctx, '')).toEqual({ userId: '7', rest: [] });
  });
});

describe('moderation commands: /ban', () => {
  it('calls ModerationService.ban with the resolved target and reason, then reports success', async () => {
    const moderation = { ban: vi.fn(async (): Promise<ModerationOutcome> => ({ status: 'succeeded', willRetry: false })) } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const ban = module.commands!.find((c) => c.name === 'ban')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 2 } } } }) });

    await ban.execute(context, 'spamming the group');

    expect(moderation.ban).toHaveBeenCalledWith({ chatId: '-100111', targetUserId: '2', actorUserId: '9', reason: 'spamming the group' });
    expect(context.sentMessages).toEqual([{ key: 'moderation.succeeded', options: { action: 'ban' } }]);
  });

  it('replies moderation.needsTarget and never calls the service when there is no resolvable target', async () => {
    const moderation = { ban: vi.fn() } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const ban = module.commands!.find((c) => c.name === 'ban')!;
    const context = fakeContext();

    await ban.execute(context, 'no target here');

    expect(moderation.ban).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'moderation.needsTarget' }]);
  });

  it('omits reason entirely (not an empty string) when no reason text was given', async () => {
    const moderation = { ban: vi.fn(async (): Promise<ModerationOutcome> => ({ status: 'succeeded', willRetry: false })) } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const ban = module.commands!.find((c) => c.name === 'ban')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 2 } } } }) });

    await ban.execute(context, '');

    expect(moderation.ban).toHaveBeenCalledWith({ chatId: '-100111', targetUserId: '2', actorUserId: '9' });
  });
});

describe('moderation commands: /restrict', () => {
  it('parses the leading token as duration in seconds and the rest as reason', async () => {
    const moderation = { restrict: vi.fn(async (): Promise<ModerationOutcome> => ({ status: 'succeeded', willRetry: false })) } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const restrict = module.commands!.find((c) => c.name === 'restrict')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 3 } } } }) });

    await restrict.execute(context, '3600 excessive flooding');

    expect(moderation.restrict).toHaveBeenCalledWith({ chatId: '-100111', targetUserId: '3', actorUserId: '9', durationSeconds: 3600, reason: 'excessive flooding' });
  });

  it('rejects a non-numeric duration with moderation.needsDuration, without calling the service', async () => {
    const moderation = { restrict: vi.fn() } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const restrict = module.commands!.find((c) => c.name === 'restrict')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 3 } } } }) });

    await restrict.execute(context, 'not-a-number some reason');

    expect(moderation.restrict).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'moderation.needsDuration' }]);
  });

  it('rejects a duration below Telegram\'s 30-second minimum', async () => {
    const moderation = { restrict: vi.fn() } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const restrict = module.commands!.find((c) => c.name === 'restrict')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 3 } } } }) });

    await restrict.execute(context, '10');

    expect(moderation.restrict).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'moderation.needsDuration' }]);
  });

  it('rejects a zero or negative duration', async () => {
    const moderation = { restrict: vi.fn() } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const restrict = module.commands!.find((c) => c.name === 'restrict')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 3 } } } }) });

    await restrict.execute(context, '0');
    await restrict.execute(context, '-60');

    expect(moderation.restrict).not.toHaveBeenCalled();
  });

  it('rejects a fractional duration (must be a whole number of seconds)', async () => {
    const moderation = { restrict: vi.fn() } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const restrict = module.commands!.find((c) => c.name === 'restrict')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 3 } } } }) });

    await restrict.execute(context, '60.5');

    expect(moderation.restrict).not.toHaveBeenCalled();
  });
});

describe('moderation commands: /delmsg', () => {
  it('requires a reply and never calls the service without one', async () => {
    const moderation = { deleteMessage: vi.fn() } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const delmsg = module.commands!.find((c) => c.id === 'moderation.delete-message')!;
    const context = fakeContext();

    await delmsg.execute(context, '');

    expect(moderation.deleteMessage).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'moderation.needsReply' }]);
  });

  it('passes the replied-to message id and its author as knownAuthorUserId', async () => {
    const moderation = { deleteMessage: vi.fn(async (): Promise<ModerationOutcome> => ({ status: 'succeeded', willRetry: false })) } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const delmsg = module.commands!.find((c) => c.id === 'moderation.delete-message')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { message_id: 777, from: { id: 5 } } } }) });

    await delmsg.execute(context, '');

    expect(moderation.deleteMessage).toHaveBeenCalledWith('-100111', '777', '9', '5');
  });

  it('still deletes when the replied-to message has no from (e.g. anonymous admin post) — knownAuthorUserId is undefined, not fabricated', async () => {
    const moderation = { deleteMessage: vi.fn(async (): Promise<ModerationOutcome> => ({ status: 'succeeded', willRetry: false })) } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const delmsg = module.commands!.find((c) => c.id === 'moderation.delete-message')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { message_id: 777 } } }) });

    await delmsg.execute(context, '');

    expect(moderation.deleteMessage).toHaveBeenCalledWith('-100111', '777', '9', undefined);
  });
});

describe('reportOutcome (via any command)', () => {
  it.each([
    ['succeeded', 'moderation.succeeded'],
    ['failed', 'moderation.failed'],
    ['unknown', 'moderation.unknown'],
  ] as const)('maps outcome status "%s" to i18n key "%s"', async (status, expectedKey) => {
    const moderation = { ban: vi.fn(async (): Promise<ModerationOutcome> => ({ status, willRetry: false })) } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const ban = module.commands!.find((c) => c.name === 'ban')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 2 } } } }) });

    await ban.execute(context, '');

    expect(context.sentMessages).toEqual([{ key: expectedKey, options: { action: 'ban' } }]);
  });

  it('reports moderation.pending — not the final status key — when the operation is still retrying (willRetry)', async () => {
    const moderation = { ban: vi.fn(async (): Promise<ModerationOutcome> => ({ status: 'unknown', willRetry: true })) } as unknown as ModerationService;
    const module = createModerationModule(moderation);
    const ban = module.commands!.find((c) => c.name === 'ban')!;
    const context = fakeContext({ ctx: fakeReplyCtx({ message: { reply_to_message: { from: { id: 2 } } } }) });

    await ban.execute(context, '');

    expect(context.sentMessages).toEqual([{ key: 'moderation.pending', options: { action: 'ban' } }]);
  });
});

describe('createModerationModule wiring sanity', () => {
  it('exposes exactly the six documented commands', () => {
    const command = commandByName('ban');
    expect(command.permission).toBe('chat_admin');
    const module = createModerationModule({} as unknown as ModerationService);
    expect(module.commands?.map((c) => c.name).sort()).toEqual(['ban', 'delmsg', 'kick', 'restrict', 'unban', 'unrestrict'].sort());
  });
});

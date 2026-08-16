import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';

import { helpModule } from '../../src/modules/global/help.js';
import type { CommandExecutionContext, TelegramBotModule } from '../../src/core/contracts.js';

function fakeContext(registry: unknown): CommandExecutionContext & { replies: string[] } {
  const replies: string[] = [];
  const context = {
    ctx: {} as Context,
    chatId: '-100111',
    userId: '9',
    moduleId: 'help',
    registry: registry as never,
    logger: {} as never,
    reply: { send: vi.fn(async (_ctx: unknown, text: string) => { replies.push(text); }) } as never,
    events: {} as never,
    t: (key: string): string => key,
  } as CommandExecutionContext;
  return Object.assign(context, { replies });
}

const helpCommand = helpModule.commands![0]!;

describe('/help', () => {
  it('lists commands of enabled modules only', async () => {
    const context = fakeContext({
      listStates: vi.fn(async () => [
        { id: 'help', enabled: true },
        { id: 'moderation', enabled: true },
        { id: 'membership-audit', enabled: false },
      ]),
      modules: [
        { id: 'help', commands: [{ name: 'help' }] },
        { id: 'moderation', commands: [{ name: 'ban' }, { name: 'unban' }] },
        { id: 'membership-audit', commands: [{ name: 'invisible' }] },
      ] as unknown as readonly TelegramBotModule[],
    });

    await helpCommand.execute(context, '');

    const listing = context.replies[0]!;
    expect(listing).toContain('/help');
    expect(listing).toContain('/ban');
    expect(listing).toContain('/unban');
    expect(listing).not.toContain('/invisible');
  });

  it('still shows the title when every optional module is disabled', async () => {
    const context = fakeContext({
      listStates: vi.fn(async () => [
        { id: 'help', enabled: true },
        { id: 'moderation', enabled: false },
      ]),
      modules: [
        { id: 'help', commands: [{ name: 'help' }] },
        { id: 'moderation', commands: [{ name: 'ban' }] },
      ] as unknown as readonly TelegramBotModule[],
    });

    await helpCommand.execute(context, '');

    const listing = context.replies[0]!;
    expect(listing).toContain('help.title');
    expect(listing).toContain('/help');
    expect(listing).not.toContain('/ban');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';

import { createChatSettingsModule } from '../../src/modules/global/chatSettings.js';
import type { CommandExecutionContext } from '../../src/core/contracts.js';
import type { ChatSettingsService } from '../../src/lib/chatSettings.js';

function fakeContext(): CommandExecutionContext & { sentMessages: Array<{ key: string; options?: Record<string, unknown> }> } {
  const sentMessages: Array<{ key: string; options?: Record<string, unknown> }> = [];
  const t = (key: string, options?: Record<string, string | number>): string => {
    sentMessages.push({ key, ...(options ? { options } : {}) });
    return key;
  };
  const context = {
    ctx: {} as Context,
    chatId: '-100111',
    userId: '9',
    moduleId: 'chat-settings',
    registry: {} as never,
    logger: {} as never,
    reply: { send: vi.fn(async () => undefined) } as never,
    events: {} as never,
    t,
  } as CommandExecutionContext;
  return Object.assign(context, { sentMessages });
}

describe('/setlocale', () => {
  it('accepts a supported locale, calls ChatSettingsService.setLocale, and reports the change', async () => {
    const chatSettings = { setLocale: vi.fn(async () => undefined) } as unknown as ChatSettingsService;
    const module = createChatSettingsModule(chatSettings);
    const command = module.commands![0]!;
    const context = fakeContext();

    await command.execute(context, 'en');

    expect(chatSettings.setLocale).toHaveBeenCalledWith('-100111', 'en', '9');
    expect(context.sentMessages).toEqual([{ key: 'chatSettings.changed', options: { locale: 'en' } }]);
  });

  it('is case-insensitive ("RU" is accepted as "ru")', async () => {
    const chatSettings = { setLocale: vi.fn(async () => undefined) } as unknown as ChatSettingsService;
    const module = createChatSettingsModule(chatSettings);
    const command = module.commands![0]!;
    const context = fakeContext();

    await command.execute(context, 'RU');

    expect(chatSettings.setLocale).toHaveBeenCalledWith('-100111', 'ru', '9');
  });

  it('rejects an unsupported locale and never calls the service', async () => {
    const chatSettings = { setLocale: vi.fn() } as unknown as ChatSettingsService;
    const module = createChatSettingsModule(chatSettings);
    const command = module.commands![0]!;
    const context = fakeContext();

    await command.execute(context, 'fr');

    expect(chatSettings.setLocale).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'common.invalidArguments' }]);
  });

  it('rejects an empty argument', async () => {
    const chatSettings = { setLocale: vi.fn() } as unknown as ChatSettingsService;
    const module = createChatSettingsModule(chatSettings);
    const command = module.commands![0]!;
    const context = fakeContext();

    await command.execute(context, '');

    expect(chatSettings.setLocale).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'common.invalidArguments' }]);
  });
});

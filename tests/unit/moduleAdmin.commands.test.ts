import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';

import { moduleAdminModule } from '../../src/modules/global/moduleAdmin.js';
import { ProtectedModuleDisableError } from '../../src/core/registry.js';
import type { CommandExecutionContext, TelegramBotModule } from '../../src/core/contracts.js';

function fakeContext(registry: unknown): CommandExecutionContext & { sentMessages: Array<{ key: string; options?: Record<string, unknown> }> } {
  const sentMessages: Array<{ key: string; options?: Record<string, unknown> }> = [];
  const t = (key: string, options?: Record<string, string | number>): string => {
    sentMessages.push({ key, ...(options ? { options } : {}) });
    return key;
  };
  const context = {
    ctx: {} as Context,
    chatId: '-100111',
    userId: '9',
    moduleId: 'module-admin',
    registry: registry as never,
    logger: {} as never,
    reply: { send: vi.fn(async () => undefined) } as never,
    events: {} as never,
    t,
  } as CommandExecutionContext;
  return Object.assign(context, { sentMessages });
}

function command(id: string) {
  return moduleAdminModule.commands!.find((command) => command.id === id)!;
}

const moderationModule = { id: 'moderation', name: 'Moderation', global: false, defaultEnabled: false } as TelegramBotModule;

describe('/modules', () => {
  it('lists every module state with its localized label', async () => {
    const context = fakeContext({
      listStates: vi.fn(async () => [
        { id: 'module-admin', enabled: true },
        { id: 'moderation', enabled: false },
      ]),
    });
    await command('modules.list').execute(context, '');

    // Строки списка локализуются до отправки, поэтому лейблы идут перед заголовком.
    expect(context.sentMessages).toEqual([
      { key: 'modules.enabled' },
      { key: 'modules.disabled' },
      { key: 'modules.title' },
    ]);
    expect(context.reply.send).toHaveBeenCalledTimes(1);
    const sentText = (context.reply.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(sentText).toContain('module-admin: modules.enabled');
    expect(sentText).toContain('moderation: modules.disabled');
  });
});

describe('/module_enable', () => {
  it('enables a known module and reports the new state', async () => {
    const setEnabled = vi.fn(async () => undefined);
    const context = fakeContext({ get: vi.fn(() => moderationModule), setEnabled });

    await command('modules.enable').execute(context, { moduleId: 'moderation' });

    expect(setEnabled).toHaveBeenCalledWith('-100111', 'moderation', true, '9');
    // Лейбл нового состояния интерполируется в сообщение об изменении.
    expect(context.sentMessages).toEqual([
      { key: 'modules.enabled' },
      { key: 'modules.changed', options: { moduleId: 'moderation', state: 'modules.enabled' } },
    ]);
  });

  it('rejects an unknown module without touching state', async () => {
    const setEnabled = vi.fn(async () => undefined);
    const context = fakeContext({ get: vi.fn(() => undefined), setEnabled });

    await command('modules.enable').execute(context, { moduleId: 'nonexistent' });

    expect(setEnabled).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'modules.unknown', options: { moduleId: 'nonexistent' } }]);
  });
});

describe('/module_disable', () => {
  it('disables a regular module and reports the new state', async () => {
    const setEnabled = vi.fn(async () => undefined);
    const context = fakeContext({ get: vi.fn(() => moderationModule), setEnabled });

    await command('modules.disable').execute(context, { moduleId: 'moderation' });

    expect(setEnabled).toHaveBeenCalledWith('-100111', 'moderation', false, '9');
    expect(context.sentMessages).toEqual([
      { key: 'modules.disabled' },
      { key: 'modules.changed', options: { moduleId: 'moderation', state: 'modules.disabled' } },
    ]);
  });

  it('refuses a protected module with a localized reply, not an internal error (BOTS-13 lockout regression)', async () => {
    const setEnabled = vi.fn(async () => {
      throw new ProtectedModuleDisableError('module-admin');
    });
    const context = fakeContext({ get: vi.fn(() => moduleAdminModule), setEnabled });

    await expect(command('modules.disable').execute(context, { moduleId: 'module-admin' })).resolves.toBeUndefined();

    expect(setEnabled).toHaveBeenCalledWith('-100111', 'module-admin', false, '9');
    expect(context.sentMessages).toEqual([{ key: 'modules.protected', options: { moduleId: 'module-admin' } }]);
  });

  it('re-throws unexpected registry failures for the dispatcher error path', async () => {
    const context = fakeContext({
      get: vi.fn(() => moderationModule),
      setEnabled: vi.fn(async () => {
        throw new Error('database down');
      }),
    });

    await expect(command('modules.disable').execute(context, { moduleId: 'moderation' })).rejects.toThrow('database down');
  });

  it('rejects an unknown module without touching state', async () => {
    const setEnabled = vi.fn(async () => undefined);
    const context = fakeContext({ get: vi.fn(() => undefined), setEnabled });

    await command('modules.disable').execute(context, { moduleId: 'nonexistent' });

    expect(setEnabled).not.toHaveBeenCalled();
    expect(context.sentMessages).toEqual([{ key: 'modules.unknown', options: { moduleId: 'nonexistent' } }]);
  });
});

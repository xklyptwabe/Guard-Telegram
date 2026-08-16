import { describe, expect, it, vi } from 'vitest';

import { ModuleRegistry, ProtectedModuleDisableError, resolveModuleEnabled } from '../../src/core/registry.js';
import { moduleAdminModule } from '../../src/modules/global/moduleAdmin.js';
import type { TelegramBotModule } from '../../src/core/contracts.js';

describe('sparse module state', () => {
  it('uses a module default while no chat override exists', () => {
    expect(resolveModuleEnabled(true, undefined)).toBe(true);
    expect(resolveModuleEnabled(false, undefined)).toBe(false);
  });

  it('uses an explicit chat override without affecting other chats', () => {
    expect(resolveModuleEnabled(true, false)).toBe(false);
    expect(resolveModuleEnabled(false, true)).toBe(true);
  });
});

describe('protected modules (BOTS-13 lockout fix)', () => {
  const moderationModule = { id: 'moderation', name: 'Moderation', global: false, defaultEnabled: false } as TelegramBotModule;
  const silentLogger = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined } as never;

  // The allowed paths (enable, disable of ordinary modules) need a real
  // database for the transaction body — covered by the integration suites;
  // this unit test pins the rejection boundary: a protected module is
  // refused BEFORE any audit or database work happens.
  it('refuses to disable a protectFromDisable module before any audit/db work', async () => {
    const recordEntityChange = vi.fn(async () => ({ duplicate: false }));
    const registry = new ModuleRegistry([moduleAdminModule, moderationModule], {} as never, { recordEntityChange } as never, {} as never, silentLogger);

    await expect(registry.setEnabled('-100111', 'module-admin', false, '9')).rejects.toBeInstanceOf(ProtectedModuleDisableError);
    expect(recordEntityChange).not.toHaveBeenCalled();
  });
});

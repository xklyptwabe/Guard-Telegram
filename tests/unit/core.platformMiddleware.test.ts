import { describe, expect, it, vi } from 'vitest';

import { UpdateBusyError, registerModuleUpdateHandlers, registerPlatformMiddleware } from '../../src/core/updates.js';
import { AuditFinalizationPendingError } from '../../src/lib/moderation/pendingOperationsOutbox.js';
import type { Logger } from '../../src/lib/logger.js';

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('UpdateBusyError (round-3)', () => {
  it('is the signal both webhook and long_polling must raise on transient busy', () => {
    const error = new UpdateBusyError('42', 'lease_held');
    expect(error.name).toBe('UpdateBusyError');
    expect(error.message).toContain('lease_held');
  });
});

describe('registerModuleUpdateHandlers (round-3)', () => {
  it('rethrow AuditFinalizationPendingError so the inbox does not complete', async () => {
    const handlers: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = [];
    const bot = { use: (fn: (ctx: any, next: () => Promise<void>) => Promise<void>) => handlers.push(fn) };
    const module = {
      id: 'membership-audit',
      updateHandlers: [
        {
          id: 'chat_member',
          handle: async () => {
            throw new AuditFinalizationPendingError('owed');
          },
        },
      ],
    };
    const registry = { isEnabled: vi.fn(async () => true) };
    registerModuleUpdateHandlers(bot as never, [module] as never, registry as never, logger());
    const next = vi.fn(async () => undefined);
    await expect(handlers[0]!({ chat: { id: 1 } }, next)).rejects.toBeInstanceOf(AuditFinalizationPendingError);
    expect(next).not.toHaveBeenCalled();
  });
});

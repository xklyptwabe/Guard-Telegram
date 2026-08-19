import { describe, expect, it, vi } from 'vitest';

import { hasPermission } from '../../src/lib/permissions.js';

describe('hasPermission', () => {
  it('round-4: private chats are NOT chat_admin', async () => {
    const ctx = { chat: { id: 1, type: 'private' }, from: { id: 2 } } as never;
    await expect(hasPermission(ctx, 'chat_admin')).resolves.toBe(false);
    await expect(hasPermission(ctx, 'none')).resolves.toBe(true);
  });

  it('treats group administrator as chat_admin', async () => {
    const ctx = {
      chat: { id: -100, type: 'supergroup' },
      from: { id: 2 },
      api: { getChatMember: vi.fn(async () => ({ status: 'administrator' })) },
    } as never;
    await expect(hasPermission(ctx, 'chat_admin')).resolves.toBe(true);
  });

  it('rejects a regular group member', async () => {
    const ctx = {
      chat: { id: -100, type: 'supergroup' },
      from: { id: 2 },
      api: { getChatMember: vi.fn(async () => ({ status: 'member' })) },
    } as never;
    await expect(hasPermission(ctx, 'chat_admin')).resolves.toBe(false);
  });
});

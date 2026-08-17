import { describe, expect, it, vi } from 'vitest';

import { ChatSettingsService, MissingChatSettingsAuditIdempotencyKeyError } from '../../src/lib/chatSettings.js';
import type { AuditService } from '../../src/lib/auditService.js';
import { runWithUpdateContext } from '../../src/lib/context.js';

function fakeDb(initialLocale: string | undefined) {
  let locale = initialLocale;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: () => Promise.resolve(locale !== undefined ? [{ locale }] : []),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: (values: { locale: string }) => ({
        onConflictDoUpdate: (opts: { set: { locale: string } }) => {
          locale = opts.set.locale;
          void values;
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: tx as never, tx, getLocale: () => locale };
}

function fakeAuditService() {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: (tx: unknown) => Promise<unknown>) => {
      // ChatSettingsService's mutate reaches into `this.db`/`tx` directly for the actual row write — pass the same fake db object recordEntityChange would give it in production (a drizzle transaction).
      const result = await mutate((audit as unknown as { __tx: unknown }).__tx);
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
  } as unknown as AuditService & { __tx: unknown };
  return { audit, calls };
}

describe('ChatSettingsService.setLocale', () => {
  it('writes the row and records chat.settings.changed with operation "update" on a real change', async () => {
    const { db, tx } = fakeDb('ru');
    const { audit, calls } = fakeAuditService();
    (audit as unknown as { __tx: unknown }).__tx = tx;
    const service = new ChatSettingsService(db, audit);

    await runWithUpdateContext({ updateId: '1', chatId: 'chat-1' }, () => service.setLocale('chat-1', 'en', 'user-1'));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { eventType: string; idempotencyKey: string }; result: { before?: Record<string, unknown>; after?: Record<string, unknown>; metadata?: Record<string, unknown> } };
    expect(call.input.eventType).toBe('chat.settings.changed');
    expect(call.input.idempotencyKey).toBe('chat.settings.changed:telegram-update:unscoped-bot:1:chat-1');
    expect(call.result.before).toMatchObject({ locale: 'ru' });
    expect(call.result.after).toMatchObject({ locale: 'en' });
    expect(call.result.metadata).toMatchObject({ operation: 'update' });
  });

  it('uses the schema default ("ru") as before, never fabricating a value, when the chat had no settings row yet', async () => {
    const { db, tx } = fakeDb(undefined);
    const { audit, calls } = fakeAuditService();
    (audit as unknown as { __tx: unknown }).__tx = tx;
    const service = new ChatSettingsService(db, audit);

    await runWithUpdateContext({ updateId: '1', chatId: 'chat-1' }, () => service.setLocale('chat-1', 'en'));

    const call = calls[0] as { result: { before?: Record<string, unknown> } };
    expect(call.result.before).toMatchObject({ locale: 'ru' });
  });

  it('records operation "noop" when the requested locale is already current', async () => {
    const { db, tx } = fakeDb('en');
    const { audit, calls } = fakeAuditService();
    (audit as unknown as { __tx: unknown }).__tx = tx;
    const service = new ChatSettingsService(db, audit);

    await runWithUpdateContext({ updateId: '1', chatId: 'chat-1' }, () => service.setLocale('chat-1', 'en'));

    const call = calls[0] as { result: { metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toMatchObject({ operation: 'noop' });
  });

  it('throws rather than silently using an unstable idempotency key when there is no update context and no explicit override', async () => {
    const { db, tx } = fakeDb('ru');
    const { audit } = fakeAuditService();
    (audit as unknown as { __tx: unknown }).__tx = tx;
    const service = new ChatSettingsService(db, audit);

    await expect(service.setLocale('chat-1', 'en')).rejects.toBeInstanceOf(MissingChatSettingsAuditIdempotencyKeyError);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { recordMemberStatusChanged } from '../../src/lib/audit/memberAudit.js';
import type { AuditService } from '../../src/lib/auditService.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import type { Logger } from '../../src/lib/logger.js';

function loadFixture(name: string): any {
  const path = fileURLToPath(new URL(`../fixtures/updates/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Mirrors registry.setEnabled.test.ts's fakeAuditService: records every recordEntityChange call and its mutate() return value, and lets a test configure what the "current entity snapshot" read inside mutate() sees. */
function fakeAuditService(currentSnapshotRows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const fakeTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(currentSnapshotRows),
        }),
      }),
    }),
  };
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: (tx: unknown) => Promise<unknown>) => {
      const result = await mutate(fakeTx);
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
  } as unknown as AuditService;
  return { audit, calls };
}

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('recordMemberStatusChanged', () => {
  it('audits a real promotion using the update\'s actual old/new chat_member statuses', async () => {
    const fixture = loadFixture('chat_member.promoted.json');
    const { audit, calls } = fakeAuditService();
    const testLogger = logger();
    const ctx = { chatMember: fixture.chat_member } as never;

    await runWithUpdateContext({ updateId: String(fixture.update_id), botId: 'bot-42', chatId: '-1001111111111' }, () => recordMemberStatusChanged(audit, testLogger, ctx));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { eventType: string; subjectId: string; idempotencyKey: string }; result: { before?: Record<string, unknown>; after?: Record<string, unknown>; metadata?: Record<string, unknown> } };
    expect(call.input.eventType).toBe('member.status.changed');
    expect(call.input.subjectId).toBe('-1001111111111:222222');
    expect(call.input.idempotencyKey).toBe('member.status.changed:telegram-update:bot-42:100003:-1001111111111:222222');
    expect(call.result.before).toMatchObject({ status: 'member' });
    expect(call.result.after).toMatchObject({ status: 'administrator' });
    expect(call.result.metadata).toMatchObject({ operation: 'update' });
    expect(testLogger.warn).not.toHaveBeenCalled();
  });

  it('audits a ban the same way, using the real "kicked" status Telegram sends', async () => {
    const fixture = loadFixture('chat_member.banned.json');
    const { audit, calls } = fakeAuditService();
    const ctx = { chatMember: fixture.chat_member } as never;

    await runWithUpdateContext({ updateId: String(fixture.update_id), chatId: '-1001111111111' }, () => recordMemberStatusChanged(audit, logger(), ctx));

    const call = calls[0] as { result: { after?: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ status: 'kicked' });
  });

  it('is a no-op (never calls recordEntityChange) when there is no chat_member on the update', async () => {
    const { audit, calls } = fakeAuditService();
    await runWithUpdateContext({ updateId: '1', chatId: 'chat-1' }, () => recordMemberStatusChanged(audit, logger(), {} as never));
    expect(calls).toHaveLength(0);
    expect(audit.recordEntityChange).not.toHaveBeenCalled();
  });

  it('handles an incomplete update (missing new_chat_member.status) by logging a warning and never calling recordEntityChange — never fabricates a status', async () => {
    const { audit, calls } = fakeAuditService();
    const testLogger = logger();
    const ctx = {
      chatMember: {
        chat: { id: -100 },
        date: 1770000000,
        old_chat_member: { status: 'member', user: { id: 2 } },
        new_chat_member: { user: { id: 2 } }, // status missing
      },
    } as never;

    await runWithUpdateContext({ updateId: '1', chatId: '-100' }, () => recordMemberStatusChanged(audit, testLogger, ctx));

    expect(calls).toHaveLength(0);
    expect(testLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.member_status_changed.incomplete_update' }));
  });

  it('reports operation "noop" when old and new status are actually the same', async () => {
    const { audit, calls } = fakeAuditService();
    const ctx = {
      chatMember: {
        chat: { id: -100 },
        from: { id: 9 },
        date: 1770000000,
        old_chat_member: { status: 'member', user: { id: 2 } },
        new_chat_member: { status: 'member', user: { id: 2 } },
      },
    } as never;

    await runWithUpdateContext({ updateId: '1', chatId: '-100' }, () => recordMemberStatusChanged(audit, logger(), ctx));

    const call = calls[0] as { result: { metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toMatchObject({ operation: 'noop' });
  });

  it('does not regress the current snapshot when the update is older than what is already on file (out-of-order redelivery)', async () => {
    // A prior, *newer* observation already recorded status "kicked" at a later `date`.
    const { audit, calls } = fakeAuditService([{ snapshotData: { status: 'kicked', observedAt: new Date(2_000_000_000 * 1000).toISOString() } }]);
    const ctx = {
      chatMember: {
        chat: { id: -100 },
        from: { id: 9 },
        date: 1_000_000_000, // older than the recorded observedAt above
        old_chat_member: { status: 'member', user: { id: 2 } },
        new_chat_member: { status: 'administrator', user: { id: 2 } },
      },
    } as never;

    await runWithUpdateContext({ updateId: '1', chatId: '-100' }, () => recordMemberStatusChanged(audit, logger(), ctx));

    const call = calls[0] as { result: { after?: Record<string, unknown>; metadata?: Record<string, unknown>; snapshotData?: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ status: 'administrator' });
    expect(call.result.snapshotData).toMatchObject({ status: 'kicked' });
    expect(call.result.metadata).toMatchObject({ operation: 'noop', outOfOrder: true });
  });

  it('round-3: infrastructure audit failure is NOT swallowed — throws AuditFinalizationPendingError', async () => {
    const { AuditFinalizationPendingError } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
    const audit = {
      recordEntityChange: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as AuditService;
    const fixture = loadFixture('chat_member.promoted.json');
    const ctx = { chatMember: fixture.chat_member } as never;
    await expect(
      runWithUpdateContext({ updateId: String(fixture.update_id), chatId: '-1001111111111' }, () => recordMemberStatusChanged(audit, logger(), ctx)),
    ).rejects.toBeInstanceOf(AuditFinalizationPendingError);
  });
});

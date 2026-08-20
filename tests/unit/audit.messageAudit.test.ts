import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { recordMessageDeleted, recordMessageEdited, recordMessageObserved } from '../../src/lib/audit/messageAudit.js';
import type { AuditService } from '../../src/lib/auditService.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import type { Logger } from '../../src/lib/logger.js';

function loadFixture(name: string): any {
  const path = fileURLToPath(new URL(`../fixtures/updates/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fakeAuditService(currentSnapshotRows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const fakeTx = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(currentSnapshotRows) }) }) }),
  };
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: (tx: unknown) => Promise<unknown>) => {
      const result = await mutate(fakeTx);
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
    observeCurrentSnapshot: vi.fn(async () => undefined),
    maskOutboxMetadata: vi.fn(async (input: { metadata: Record<string, unknown> }) => input.metadata),
  } as unknown as AuditService;
  return { audit, calls };
}

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('recordMessageEdited', () => {
  it('audits a real edited_message update, with before_status not_observed for a message never seen before', async () => {
    const fixture = loadFixture('edited_message.json');
    const { audit, calls } = fakeAuditService([]); // no prior snapshot
    const ctx = { editedMessage: fixture.edited_message } as never;

    await runWithUpdateContext({ updateId: String(fixture.update_id), chatId: '-1001111111111' }, () => recordMessageEdited(audit, logger(), ctx));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { eventType: string; subjectId: string }; result: { beforeSnapshotStatus?: string; metadata?: Record<string, unknown> } };
    expect(call.input.eventType).toBe('message.edited');
    expect(call.input.subjectId).toBe('-1001111111111:503');
    expect(call.result.beforeSnapshotStatus).toBe('not_observed');
    expect(call.result.metadata).toMatchObject({ operation: 'create' });
  });

  it('is a no-op when there is no edited_message/edited_channel_post on the update', async () => {
    const { audit, calls } = fakeAuditService();
    await runWithUpdateContext({ updateId: '1', chatId: 'chat-1' }, () => recordMessageEdited(audit, logger(), {} as never));
    expect(calls).toHaveLength(0);
  });

  it('logs and skips rather than fabricating an author when the update has no from (e.g. anonymous admin post)', async () => {
    const { audit, calls } = fakeAuditService();
    const testLogger = logger();
    const ctx = { editedMessage: { message_id: 1, chat: { id: -100 }, edit_date: 123, text: 'x' } } as never;

    await runWithUpdateContext({ updateId: '1', chatId: '-100' }, () => recordMessageEdited(audit, testLogger, ctx));

    expect(calls).toHaveLength(0);
    expect(testLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.message_edited.no_author' }));
  });

  it('BOTS-9 review HIGH-1: an OLDER edit arriving after a newer one is audited as a noop and never regresses the current snapshot', async () => {
    // Current snapshot already reflects a 2033 edit; the incoming update is
    // an older 2001 edit with a DIFFERENT update_id (so the idempotency key
    // does not catch it) — exactly the review's runtime reproduction.
    const { audit, calls } = fakeAuditService([
      { snapshotData: { chatId: '-100', messageId: '503', userId: '111111', editedAt: '2033-01-01T00:00:00.000Z', textLength: 12, text: 'newer version' } },
    ]);
    const ctx = { editedMessage: { message_id: 503, chat: { id: -100 }, from: { id: 111111 }, edit_date: new Date('2001-01-01T00:00:00Z').getTime() / 1000, text: 'stale older version' } } as never;

    await runWithUpdateContext({ updateId: '777', chatId: '-100', botId: '42' }, () => recordMessageEdited(audit, logger(), ctx));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { result: { after?: Record<string, unknown>; snapshotData?: Record<string, unknown>; metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toMatchObject({ operation: 'noop', outOfOrder: true });
    // The snapshot keeps the NEWER data — the stale edit did not regress it.
    expect(call.result.snapshotData).toMatchObject({ editedAt: '2033-01-01T00:00:00.000Z', text: 'newer version' });
    expect(call.result.after).toMatchObject({ editedAt: '2001-01-01T00:00:00.000Z' });
  });

  it('BOTS-9 review HIGH-1: a genuinely newer edit still updates the snapshot normally', async () => {
    const { audit, calls } = fakeAuditService([{ snapshotData: { chatId: '-100', messageId: '503', userId: '111111', editedAt: '2001-01-01T00:00:00.000Z', textLength: 5 } }]);
    const ctx = { editedMessage: { message_id: 503, chat: { id: -100 }, from: { id: 111111 }, edit_date: new Date('2026-05-05T00:00:00Z').getTime() / 1000, text: 'fresh' } } as never;

    await runWithUpdateContext({ updateId: '778', chatId: '-100', botId: '42' }, () => recordMessageEdited(audit, logger(), ctx));

    const call = calls[0] as { result: { snapshotData?: Record<string, unknown>; metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toMatchObject({ operation: 'update' });
    expect(call.result.snapshotData).toMatchObject({ editedAt: '2026-05-05T00:00:00.000Z', textLength: 5 });
  });

  it('round-3: infrastructure audit failure is NOT swallowed — throws AuditFinalizationPendingError', async () => {
    const { AuditFinalizationPendingError } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
    const audit = { recordEntityChange: vi.fn(async () => { throw new Error('db down'); }) } as unknown as AuditService;
    const fixture = loadFixture('edited_message.json');
    const ctx = { editedMessage: fixture.edited_message } as never;
    await expect(
      runWithUpdateContext({ updateId: String(fixture.update_id), chatId: '-1001111111111' }, () => recordMessageEdited(audit, logger(), ctx)),
    ).rejects.toBeInstanceOf(AuditFinalizationPendingError);
  });
});

describe('recordMessageDeleted', () => {
  it('audits a bot-performed deletion with before_status not_observed when the message was never seen before — never fabricates an author', async () => {
    const { audit, calls } = fakeAuditService([]); // never observed
    await recordMessageDeleted(audit, logger(), { chatId: '-100', messageId: '503', idempotencyKey: 'k1', deletedBy: '999' });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { result: { beforeSnapshotStatus?: string; snapshotStatus?: string; metadata?: Record<string, unknown> } };
    expect(call.result.beforeSnapshotStatus).toBe('not_observed');
    expect(call.result.snapshotStatus).toBe('archived');
    expect(call.result.metadata).not.toHaveProperty('userId'); // genuinely unknown — not fabricated
  });

  it('uses the last observed version as "before" when this message was previously edited', async () => {
    const { audit, calls } = fakeAuditService([{ snapshotData: { chatId: '-100', messageId: '503', userId: '111111', editedAt: '2026-01-01T00:00:00.000Z', textLength: 4 } }]);
    await recordMessageDeleted(audit, logger(), { chatId: '-100', messageId: '503', idempotencyKey: 'k2', deletedBy: '999' });

    const call = calls[0] as { result: { before?: Record<string, unknown>; metadata?: Record<string, unknown> } };
    expect(call.result.before).toMatchObject({ userId: '111111' });
    expect(call.result.metadata).toMatchObject({ userId: '111111' });
  });

  it('prefers a caller-supplied knownAuthorUserId (e.g. from a live reply_to_message) over an older snapshot', async () => {
    const { audit, calls } = fakeAuditService([{ snapshotData: { chatId: '-100', messageId: '503', userId: 'stale-author', editedAt: '2026-01-01T00:00:00.000Z', textLength: 1 } }]);
    await recordMessageDeleted(audit, logger(), { chatId: '-100', messageId: '503', idempotencyKey: 'k3', deletedBy: '999', knownAuthorUserId: 'fresh-author' });

    const call = calls[0] as { result: { metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toMatchObject({ userId: 'fresh-author' });
  });

  it('reuses the caller-supplied idempotencyKey exactly — this is what lets a recovered (post-restart) deletion still be audited without a live Update', async () => {
    const { audit, calls } = fakeAuditService();
    await recordMessageDeleted(audit, logger(), { chatId: '-100', messageId: '503', idempotencyKey: 'moderation.delete:telegram-update:42:-100:503:audit' });

    const call = calls[0] as { input: { idempotencyKey: string } };
    expect(call.input.idempotencyKey).toBe('moderation.delete:telegram-update:42:-100:503:audit');
  });
});

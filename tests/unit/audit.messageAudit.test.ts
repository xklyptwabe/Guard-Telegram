import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { recordMessageDeleted, recordMessageEdited, recordMessageObserved } from '../../src/lib/audit/messageAudit.js';
import type { AuditService } from '../../src/lib/auditService.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import type { Logger } from '../../src/lib/logger.js';
import { createMessageAuditModule } from '../../src/modules/global/messageAudit.js';

function loadFixture(name: string): any {
  const path = fileURLToPath(new URL(`../fixtures/updates/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fakeAuditService(currentSnapshotRows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const observations: unknown[] = [];
  const fakeTx = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(currentSnapshotRows) }) }) }),
  };
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: (tx: unknown) => Promise<unknown>) => {
      const result = await mutate(fakeTx);
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
    observeCurrentSnapshot: vi.fn(async (input: unknown) => {
      observations.push(input);
    }),
    maskOutboxMetadata: vi.fn(async (input: { metadata: Record<string, unknown> }) => input.metadata),
  } as unknown as AuditService;
  return { audit, calls, observations };
}

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('recordMessageObserved', () => {
  it('stores an ordinary message through the production module handler without creating a synthetic event', async () => {
    const fixture = loadFixture('message.command.json');
    const { audit, calls, observations } = fakeAuditService();
    const module = createMessageAuditModule(audit, logger());
    const handler = module.updateHandlers?.find((candidate) => candidate.id === 'message-audit-observed-message');

    await runWithUpdateContext(
      { updateId: String(fixture.update_id), chatId: String(fixture.message.chat.id), botId: '42' },
      async () => handler?.handle({ message: fixture.message } as never),
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      tenantId: String(fixture.message.chat.id),
      subjectType: 'message',
      subjectId: `${String(fixture.message.chat.id)}:${String(fixture.message.message_id)}`,
      eventType: 'message.edited',
      eventVersion: 'v1',
      moduleId: 'message-audit',
      observedUpdateId: fixture.update_id,
    });
    expect(calls).toHaveLength(0);
  });

  it('stores an ordinary channel post without fabricating a user through the production module handler', async () => {
    const fixture = loadFixture('bots9/channel_post.json');
    const { audit, calls, observations } = fakeAuditService();
    const module = createMessageAuditModule(audit, logger());
    const handler = module.updateHandlers?.find((candidate) => candidate.id === 'message-audit-observed-message');
    const channelPost = fixture.channel_post;

    await runWithUpdateContext(
      { updateId: String(fixture.update_id), chatId: String(channelPost.chat.id), botId: '42' },
      async () => handler?.handle({ channelPost } as never),
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      tenantId: String(channelPost.chat.id),
      subjectId: `${String(channelPost.chat.id)}:${String(channelPost.message_id)}`,
      snapshotData: {
        chatId: String(channelPost.chat.id),
        messageId: String(channelPost.message_id),
        text: channelPost.text,
      },
    });
    expect((observations[0] as { snapshotData: Record<string, unknown> }).snapshotData).not.toHaveProperty('userId');
    expect(calls).toHaveLength(0);
  });
});

describe('recordMessageEdited', () => {
  it('audits a real edited_message update, with before_status not_observed for a message never seen before', async () => {
    const fixture = loadFixture('edited_message.json');
    const { audit, calls } = fakeAuditService([]); // no prior snapshot
    const ctx = { editedMessage: fixture.edited_message } as never;

    await runWithUpdateContext({ updateId: String(fixture.update_id), botId: 'bot-42', chatId: '-1001111111111' }, () => recordMessageEdited(audit, logger(), ctx));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { eventType: string; subjectId: string; idempotencyKey: string }; result: { beforeSnapshotStatus?: string; metadata?: Record<string, unknown> } };
    expect(call.input.eventType).toBe('message.edited');
    expect(call.input.subjectId).toBe('-1001111111111:503');
    expect(call.input.idempotencyKey).toBe('message.edited:telegram-update:bot-42:100007:-1001111111111:503');
    expect(call.result.beforeSnapshotStatus).toBe('not_observed');
    expect(call.result.metadata).toMatchObject({ operation: 'create' });
  });

  it('is a no-op when there is no edited_message/edited_channel_post on the update', async () => {
    const { audit, calls } = fakeAuditService();
    await runWithUpdateContext({ updateId: '1', chatId: 'chat-1' }, () => recordMessageEdited(audit, logger(), {} as never));
    expect(calls).toHaveLength(0);
  });

  it('audits an edited message without from using the actor-optional contract', async () => {
    const { audit, calls } = fakeAuditService();
    const testLogger = logger();
    const ctx = { editedMessage: { message_id: 1, chat: { id: -100 }, edit_date: 123, text: 'x' } } as never;

    await runWithUpdateContext({ updateId: '1', chatId: '-100' }, () => recordMessageEdited(audit, testLogger, ctx));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { actorId?: string }; result: { after?: Record<string, unknown> } };
    expect(call.input).not.toHaveProperty('actorId');
    expect(call.result.after).not.toHaveProperty('userId');
    expect(testLogger.warn).not.toHaveBeenCalled();
  });

  it('audits edited_channel_post through the production module handler with an optional actor', async () => {
    const fixture = loadFixture('bots9/edited_channel_post.json');
    const { audit, calls } = fakeAuditService();
    const module = createMessageAuditModule(audit, logger());
    const handler = module.updateHandlers?.find((candidate) => candidate.id === 'message-audit-edited-message');

    await runWithUpdateContext(
      { updateId: String(fixture.update_id), chatId: String(fixture.edited_channel_post.chat.id), botId: '42' },
      async () => handler?.handle({ editedChannelPost: fixture.edited_channel_post } as never),
    );

    expect(calls).toHaveLength(1);
    const call = calls[0] as {
      input: { actorId?: string; source: string };
      result: { after?: Record<string, unknown>; snapshotData?: Record<string, unknown> };
    };
    expect(call.input).not.toHaveProperty('actorId');
    expect(call.input.source).toBe('telegram.edited_channel_post_update');
    expect(call.result.after).toMatchObject({
      chatId: '-1002222222222',
      messageId: '905',
      textLength: 27,
    });
    expect(call.result.after).not.toHaveProperty('userId');
    expect(call.result.snapshotData).not.toHaveProperty('userId');
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
  it.each(['failed', 'unknown'] as const)(
    'records a %s deletion with before_status not_observed and keeps the snapshot unobserved',
    async (outcome) => {
      const { audit, calls } = fakeAuditService([]);

      await recordMessageDeleted(audit, logger(), {
        chatId: '-100',
        messageId: '502',
        idempotencyKey: `k-unobserved-${outcome}`,
        deletedBy: '999',
        outcome,
      });

      expect(calls).toHaveLength(1);
      const call = calls[0] as {
        input: { status?: string };
        result: {
          before?: Record<string, unknown>;
          beforeSnapshotStatus?: string;
          afterSnapshotStatus?: string;
          snapshotStatus?: string;
          snapshotData?: Record<string, unknown> | null;
        };
      };
      expect(call.input.status).toBe(outcome);
      expect(call.result.before).toBeUndefined();
      expect(call.result.beforeSnapshotStatus).toBe('not_observed');
      expect(call.result.afterSnapshotStatus).toBe('not_applicable');
      expect(call.result.snapshotStatus).toBe('current');
      expect(call.result.snapshotData).toBeNull();
    },
  );

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

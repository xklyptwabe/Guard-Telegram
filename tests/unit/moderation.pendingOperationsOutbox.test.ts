import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';
import type { Logger } from '../../src/lib/logger.js';
import { buildDrizzleOrmMock, FakePendingOperationsDb, fakeLogger } from './testUtils/fakePendingOperationsDb.js';

vi.mock('drizzle-orm', async (importOriginal) => buildDrizzleOrmMock(await importOriginal<typeof import('drizzle-orm')>()));

const { pendingOperations } = await import('../../src/db/schema/moderation.js');
const { PendingOperationResolvers, PendingOperationsOutbox } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');

function logger(): Logger {
  return fakeLogger() as unknown as Logger;
}

describe('PendingOperationsOutbox', () => {
  let db: FakePendingOperationsDb;
  let resolvers: InstanceType<typeof PendingOperationResolvers>;

  beforeEach(() => {
    db = new FakePendingOperationsDb(pendingOperations);
    resolvers = new PendingOperationResolvers();
  });

  it('writes ahead, then a confirmed success is terminal and stores the result', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const executor = vi.fn(async () => ({ ok: true }));

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-1', requestPayload: { chat_id: 1, user_id: 2 } }, executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.isFinal).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.outcome).toEqual({ status: 'succeeded', result: { ok: true } });
    expect(db.rows[0]?.status).toBe('succeeded');
    // write-ahead really happened before the call resolved: exactly one row for this operation.
    expect(db.rows).toHaveLength(1);
  });

  it('sanitizes WAL metadata through the configured policy-aware sanitizer before insert', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    outbox.setMetadataSanitizer(async (input) => ({
      action: input.metadata.action,
      actorUserId: '[redacted]',
      targetUserId: input.metadata.targetUserId,
    }));

    await outbox.execute(
      {
        kind: 'telegram.banChatMember',
        chatId: 'chat-1',
        idempotencyKey: 'key-policy-metadata',
        requestPayload: { chat_id: 1, user_id: 2 },
        metadata: {
          action: 'ban',
          actorUserId: '9',
          targetUserId: '2',
          reason: 'policy-hidden-reason',
          arbitrary: 'policy-hidden-arbitrary',
        },
        auditEvent: { eventType: 'moderation.action', eventVersion: 'v1', moduleId: 'moderation' },
      },
      async () => undefined,
    );

    expect(db.rows[0]?.metadata).toEqual({ action: 'ban', actorUserId: '[redacted]', targetUserId: '2' });
    expect(JSON.stringify(db.rows[0]?.metadata)).not.toContain('policy-hidden-reason');
    expect(JSON.stringify(db.rows[0]?.metadata)).not.toContain('policy-hidden-arbitrary');
  });

  it('a confirmed GrammyError is terminal and status "failed" — never retried', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const error = new GrammyError('Bad Request: not enough rights', { ok: false, error_code: 400, description: 'Bad Request: not enough rights' } as never, 'banChatMember', {});
    const executor = vi.fn(async () => {
      throw error;
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-2', requestPayload: {} }, executor);

    expect(result.isFinal).toBe(true);
    expect(result.outcome.status).toBe('failed');
    expect(db.rows[0]?.status).toBe('failed');
    expect(db.rows[0]?.attemptCount).toBe(1);

    // Calling again with the same idempotencyKey must not re-invoke the executor.
    const second = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-2', requestPayload: {} }, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(second.duplicate).toBe(true);
    expect(second.outcome.status).toBe('failed');
  });

  it('an unconfirmed error (timeout/network) is "unknown", not "failed", and is not final while retries remain', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 5, 10);
    resolvers.register('telegram.banChatMember', async () => undefined, { retryAfterUnknown: true });
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-3', requestPayload: {} }, executor);

    expect(result.outcome.status).toBe('unknown');
    expect(result.isFinal).toBe(false); // retries remain — must not be audited yet
    expect(db.rows[0]?.status).toBe('unknown');
    expect(db.rows[0]?.nextAttemptAt).not.toBeNull();
  });

  it('a genuine timeout (executor never resolves) also becomes "unknown", never "failed"', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 5, 20);
    const executor = vi.fn(() => new Promise<void>(() => undefined)); // never resolves

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-timeout', requestPayload: {} }, executor);

    expect(result.outcome.status).toBe('unknown');
    expect(db.rows[0]?.status).toBe('unknown');
  });

  it('"unknown" becomes final (isFinal=true) once retries are exhausted', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 1, 10); // maxAttempts=1
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-4', requestPayload: {} }, executor);

    expect(result.outcome.status).toBe('unknown');
    expect(result.isFinal).toBe(true); // exhausted — this is the one moment it should be audited as unknown
    expect(db.rows[0]?.status).toBe('unknown');
  });

  it('recoverPending() resumes an interrupted row (in_progress after a crash) and calls onFinal once it resolves', async () => {
    db.rows.push({
      id: 'row-crashed',
      kind: 'telegram.banChatMember',
      chatId: 'chat-1',
      requestPayload: { chat_id: 1, user_id: 2 },
      metadata: { action: 'ban', actorUserId: '9', targetUserId: '2' },
      idempotencyKey: 'key-crashed',
      status: 'in_progress',
      attemptCount: 1,
      lastAttemptAt: new Date(),
      nextAttemptAt: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    resolvers.register('telegram.banChatMember', async () => ({ ok: true }));

    const onFinal = vi.fn(async (_row: unknown, _outcome: unknown) => ({ status: 'recorded' as const }));
    await outbox.recoverPending(onFinal);

    expect(db.rows[0]?.status).toBe('succeeded');
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect((onFinal.mock.calls[0]?.[0] as { id: string } | undefined)?.id).toBe('row-crashed');
    expect(onFinal.mock.calls[0]?.[1]).toEqual({ status: 'succeeded', result: { ok: true } });
  });

  it('recoverPending() with no resolver for a kind: releases the claim with a fresh lease — no tight claim/release loop, self-heals after the lease', async () => {
    db.rows.push({
      id: 'row-orphan',
      kind: 'telegram.someFutureCall',
      chatId: 'chat-1',
      requestPayload: {},
      metadata: {},
      idempotencyKey: 'key-orphan',
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      workerId: null,
      leaseExpiresAt: null,
      auditStatus: 'pending',
      auditWorkerId: null,
      auditLeaseExpiresAt: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);

    const onFinal = vi.fn(async () => ({ status: 'recorded' as const }));
    await outbox.recoverPending(onFinal);

    // The claim was made and counted (a genuine attempt to dispatch it
    // happened), then released with a FUTURE lease — so the same sweep did
    // not pick it up again (the old null-lease release made this loop
    // forever: claim → no resolver → release → claim → …).
    expect(db.rows[0]?.status).toBe('in_progress');
    expect(db.rows[0]?.attemptCount).toBe(1);
    expect(db.rows[0]?.workerId).toBeNull();
    expect((db.rows[0]?.leaseExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(onFinal).not.toHaveBeenCalled();

    // Self-healing: once the lease genuinely expires, a later sweep tries
    // again (e.g. after a deploy that registers the missing resolver).
    db.rows[0]!.leaseExpiresAt = new Date(Date.now() - 1);
    await outbox.recoverPending(onFinal);
    expect(db.rows[0]?.attemptCount).toBe(2);
  });

  it('two concurrent calls for the same idempotencyKey never both invoke the executor', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    const executor = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) await gate;
      return { ok: true };
    });

    const input = { kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-race', requestPayload: {} };
    const first = outbox.execute(input, executor);
    // Let the first call's write-ahead + claim land before starting the second.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = outbox.execute(input, executor);
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect([firstResult.isFinal, secondResult.isFinal].filter(Boolean)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // BOTS-9 review HIGH-3: durable audit-finalization
  // ---------------------------------------------------------------------

  it('a terminal outcome runs onFinal and durably marks audit_status="written"', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const onFinal = vi.fn(async () => ({ status: 'recorded' as const }));

    await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-a1', requestPayload: {} }, vi.fn(async () => ({ ok: 1 })), onFinal);

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(db.rows[0]?.auditStatus).toBe('written');
  });

  it('HIGH-3: an audit write failure stays owed ("pending") and the worker backfills it WITHOUT re-running the executor', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const executor = vi.fn(async () => ({ ok: 1 }));
    const failingFinalizer = vi.fn(async (): Promise<{ status: 'recorded' } | { status: 'policy_skipped' }> => {
      throw new Error('audit db down');
    });

    await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-a2', requestPayload: {} }, executor, failingFinalizer);
    expect(db.rows[0]?.status).toBe('succeeded');
    expect(db.rows[0]?.auditStatus).toBe('pending'); // the audit is still owed

    // Later: audit recovered, executor must NOT run again.
    const recoveredFinalizer = vi.fn(async () => ({ status: 'recorded' as const }));
    await outbox.recoverPending(recoveredFinalizer);

    expect(executor).toHaveBeenCalledTimes(1); // the operation itself never re-ran
    expect(recoveredFinalizer).toHaveBeenCalledTimes(1);
    expect(db.rows[0]?.auditStatus).toBe('written');
  });

  it('HIGH-3: a redelivered duplicate (already-terminal row) completes an audit the original call failed to write', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const executor = vi.fn(async () => ({ ok: 1 }));
    const failingFinalizer = vi.fn(async (): Promise<{ status: 'recorded' } | { status: 'policy_skipped' }> => {
      throw new Error('audit db down');
    });
    const input = { kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-a3', requestPayload: {} };

    await outbox.execute(input, executor, failingFinalizer);
    const second = await outbox.execute(input, executor, vi.fn(async () => ({ status: 'recorded' as const })));

    expect(executor).toHaveBeenCalledTimes(1); // duplicate never re-executes
    expect(second.duplicate).toBe(true);
    expect(db.rows[0]?.auditStatus).toBe('written'); // …but the owed audit got completed
  });

  // ---------------------------------------------------------------------
  // BOTS-9 review BLOCKER-2 residual: worker claim eligibility for `unknown`
  // ---------------------------------------------------------------------

  it('a non-final `unknown` with a future next_attempt_at is NOT re-claimed by the worker before its backoff elapses', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    resolvers.register('telegram.banChatMember', async () => undefined, { retryAfterUnknown: true });
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-b1', requestPayload: {} }, executor);
    expect(db.rows[0]?.status).toBe('unknown');
    expect(db.rows[0]?.nextAttemptAt).not.toBeNull();

    // Worker ticks immediately — nothing is due yet.
    await outbox.recoverPending();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(db.rows[0]?.attemptCount).toBe(1);

    // Backoff elapsed — the retry is due and runs without a restart.
    db.rows[0]!.nextAttemptAt = new Date(Date.now() - 1);
    resolvers.register('telegram.banChatMember', vi.fn(async () => ({ ok: 1 })));
    await outbox.recoverPending();
    expect(db.rows[0]?.attemptCount).toBe(2); // second attempt happened
  });

  it('an EXHAUSTED unknown (no next attempt scheduled) is never blindly re-executed by the worker', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 1, 10); // maxAttempts=1
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-b2', requestPayload: {} }, executor, vi.fn(async () => ({ status: 'recorded' as const })));
    expect(db.rows[0]?.status).toBe('unknown');
    expect(db.rows[0]?.nextAttemptAt).toBeNull(); // exhausted

    // Any number of worker sweeps must not re-run a possibly-already-applied
    // side effect without reconciliation (review BLOCKER-2).
    await outbox.recoverPending(vi.fn(async () => ({ status: 'recorded' as const })));
    await outbox.recoverPending(vi.fn(async () => ({ status: 'recorded' as const })));
    expect(executor).toHaveBeenCalledTimes(1);
    expect(db.rows[0]?.attemptCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // BOTS-9 review round-2: BLOCKER-1 finalizer contract, BLOCKER-2 retry
  // policy, retention tombstone
  // ---------------------------------------------------------------------

  it('BLOCKER-1: a finalizer returning policy_skipped marks audit_status="policy_skipped" — terminal, nothing owed', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const onFinal = vi.fn(async () => ({ status: 'policy_skipped' as const }));

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-c1', requestPayload: {} }, vi.fn(async () => ({ ok: 1 })), onFinal);

    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(db.rows[0]?.auditStatus).toBe('policy_skipped');
    expect(result.auditFinalized).toBe(true);

    // Backfill must NOT keep retrying the row.
    await outbox.recoverPending(vi.fn(async () => ({ status: 'recorded' as const })));
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it('BLOCKER-1: a finalizer that throws leaves audit_status="pending" and auditFinalized=false for a terminal outcome', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const failingFinalizer = vi.fn(async (): Promise<{ status: 'recorded' } | { status: 'policy_skipped' }> => {
      throw new Error('audit db down');
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-c2', requestPayload: {} }, vi.fn(async () => ({ ok: 1 })), failingFinalizer);

    expect(db.rows[0]?.auditStatus).toBe('pending');
    expect(result.auditFinalized).toBe(false); // caller must fail the update chain
  });

  it('BLOCKER-2: a kind registered retryAfterUnknown:false is terminal on the FIRST unknown — no blind retry', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    resolvers.register(
      'telegram.deleteMessage',
      async () => {
        throw new Error('socket hang up'); // unconfirmed
      },
      { retryAfterUnknown: false },
    );

    const result = await outbox.execute(
      { kind: 'telegram.deleteMessage', chatId: 'chat-1', idempotencyKey: 'key-d1', requestPayload: { chat_id: 1, message_id: 5 } },
      resolvers.get('telegram.deleteMessage')!,
      vi.fn(async () => ({ status: 'recorded' as const })),
    );

    expect(result.outcome.status).toBe('unknown');
    expect(result.isFinal).toBe(true); // terminal — never blindly re-issued
    expect(db.rows[0]?.status).toBe('unknown');
    expect(db.rows[0]?.nextAttemptAt).toBeNull();

    // Worker sweeps must not re-run it.
    await outbox.recoverPending(vi.fn(async () => ({ status: 'recorded' as const })));
    expect(db.rows[0]?.attemptCount).toBe(1);
  });

  it('BLOCKER-2: a retryable kind still retries after unknown (ban/unban semantics)', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    resolvers.register('telegram.banChatMember', async () => undefined, { retryAfterUnknown: true });
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-d2', requestPayload: {} }, executor);

    expect(db.rows[0]?.status).toBe('unknown');
    expect(db.rows[0]?.nextAttemptAt).not.toBeNull(); // retry scheduled

    db.rows[0]!.nextAttemptAt = new Date(Date.now() - 1);
    await outbox.recoverPending();
    expect(db.rows[0]?.attemptCount).toBe(2);
  });

  it('retention tombstone: a row already marked written NEVER re-invokes the finalizer on redelivery (no resurrection)', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const executor = vi.fn(async () => ({ ok: 1 }));
    const firstFinalizer = vi.fn(async () => ({ status: 'recorded' as const }));

    await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-e1', requestPayload: {} }, executor, firstFinalizer);
    expect(db.rows[0]?.auditStatus).toBe('written');

    // Retention purged the audit event; the same update is redelivered.
    const secondFinalizer = vi.fn(async () => ({ status: 'recorded' as const }));
    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-e1', requestPayload: {} }, executor, secondFinalizer);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(secondFinalizer).not.toHaveBeenCalled(); // tombstone — no re-record
    expect(result.duplicate).toBe(true);
    expect(result.auditFinalized).toBe(true);
  });

  it('auditFinalized is true for interim (non-final) outcomes — nothing owed yet', async () => {
    resolvers.register('telegram.banChatMember', async () => undefined, { retryAfterUnknown: true });
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 3, 10);
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-f1', requestPayload: {} }, executor);

    expect(result.isFinal).toBe(false);
    expect(result.auditFinalized).toBe(true);
  });
});

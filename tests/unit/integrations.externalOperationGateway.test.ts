import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import { buildDrizzleOrmMock, FakePendingOperationsDb, fakeLogger } from './testUtils/fakePendingOperationsDb.js';

vi.mock('drizzle-orm', async (importOriginal) => buildDrizzleOrmMock(await importOriginal<typeof import('drizzle-orm')>()));

const { pendingOperations } = await import('../../src/db/schema/moderation.js');
const { ConfirmedExternalError, PendingOperationResolvers, PendingOperationsOutbox } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
type PendingOperationFinalizer = import('../../src/lib/moderation/pendingOperationsOutbox.js').PendingOperationFinalizer;
const { makeIntegrationAuditFinalizer, buildOutboxFinalizer } = await import('../../src/lib/integrations/externalOperationGateway.js');
type AuditService = import('../../src/lib/auditService.js').AuditService;
type ModerationService = import('../../src/lib/moderation/moderationService.js').ModerationService;

function logger(): Logger {
  return fakeLogger() as unknown as Logger;
}

function fakeAuditService() {
  const calls: Array<{ input: Record<string, unknown> }> = [];
  const fakeTx = { select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }) };
  const audit = {
    recordEntityChange: vi.fn(async (input: Record<string, unknown>, mutate: (tx: unknown) => Promise<unknown>) => {
      await mutate(fakeTx);
      calls.push({ input });
      return { eventId: 'evt', subjectSequence: 1, duplicate: false };
    }),
  } as unknown as AuditService;
  return { audit, calls };
}

describe('integration write-ahead gateway (BOTS-9 review BLOCKER-3)', () => {
  let db: FakePendingOperationsDb;
  let resolvers: InstanceType<typeof PendingOperationResolvers>;

  beforeEach(() => {
    db = new FakePendingOperationsDb(pendingOperations);
    resolvers = new PendingOperationResolvers();
  });

  it('a confirmed provider rejection (S3 4xx via ConfirmedExternalError) is terminal failed, never unknown', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const executor = vi.fn(async () => {
      throw new ConfirmedExternalError('AccessDenied', { errorCode: 403, description: 'S3ServiceException' });
    });

    const result = await outbox.execute({ kind: 's3.putObject', chatId: 'platform', idempotencyKey: 's3-1', requestPayload: { key: 'k' }, metadata: {} }, executor);

    expect(result.outcome.status).toBe('failed');
    expect(result.outcome.result).toMatchObject({ errorCode: 403 });
    expect(result.isFinal).toBe(true);
    expect(db.rows[0]?.status).toBe('failed');
  });

  it('S3-style recovery reconciliation: a resolver proving the object exists resolves the row without re-uploading', async () => {
    resolvers.register('s3.putObject', vi.fn(async () => ({ reconciled: true, statusCode: 200 })));
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    db.rows.push({
      id: 'row-crash-mid-put',
      kind: 's3.putObject',
      chatId: 'platform',
      requestPayload: { key: 'exports/1.json' },
      metadata: { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'exports/1.json' },
      idempotencyKey: 's3-2',
      status: 'unknown',
      attemptCount: 1,
      lastAttemptAt: new Date(),
      nextAttemptAt: new Date(Date.now() - 1), // retry due
      workerId: null,
      leaseExpiresAt: null,
      auditStatus: 'pending',
      auditWorkerId: null,
      auditLeaseExpiresAt: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await outbox.recoverPending();

    expect(db.rows[0]?.status).toBe('succeeded');
    expect(db.rows[0]?.result).toMatchObject({ reconciled: true });
  });

  it('the terminal integration.action audit uses the operation\'s STABLE key — retries/backfills can never double-audit', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const { audit, calls } = fakeAuditService();
    const finalizer = makeIntegrationAuditFinalizer(audit, logger());

    const first = await outbox.execute(
      { kind: 'rabbitmq.publish', chatId: 'platform', idempotencyKey: 'rabbitmq.publish:env-1', requestPayload: { envelope: { id: 'env-1', type: 'x.y', attempt: 0, payload: null } }, metadata: { integrationId: 'rabbitmq', action: 'x.y', targetType: 'queue', targetId: 'ns.p.actions' } },
      vi.fn(async () => ({ messageId: 'env-1' })),
      finalizer,
    );
    expect(first.outcome.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.idempotencyKey).toBe('rabbitmq.publish:env-1:audit');
    expect(db.rows[0]?.auditStatus).toBe('written');

    // Redelivery of the same logical publish: executor NOT re-run. The row
    // is already marked audit_status='written', so (round-2 retention
    // tombstone) the finalizer is NOT re-invoked at all — an audit event
    // that once existed must never be resurrected after retention purges it.
    await outbox.execute(
      { kind: 'rabbitmq.publish', chatId: 'platform', idempotencyKey: 'rabbitmq.publish:env-1', requestPayload: {}, metadata: {} },
      vi.fn(),
      finalizer,
    );
    expect(calls).toHaveLength(1); // tombstone — no re-finalization
  });

  it('buildOutboxFinalizer routes telegram.* to ModerationService and everything else to the integration finalizer', async () => {
    const moderationAudit = vi.fn(async () => ({ status: 'recorded' as const }));
    const moderation = { auditRecoveredOperation: moderationAudit } as unknown as ModerationService;
    const integration: PendingOperationFinalizer = vi.fn(async () => ({ status: 'recorded' as const }));
    const finalizer = buildOutboxFinalizer(moderation, integration);

    const telegramRow = { id: 'r1', kind: 'telegram.banChatMember', chatId: 'c', requestPayload: {}, metadata: {}, idempotencyKey: 'k1', status: 'succeeded' as const, attemptCount: 1, result: null, auditStatus: 'pending' };
    const s3Row = { id: 'r2', kind: 's3.putObject', chatId: 'platform', requestPayload: {}, metadata: {}, idempotencyKey: 'k2', status: 'succeeded' as const, attemptCount: 1, result: null, auditStatus: 'pending' };
    const outcome = { status: 'succeeded' as const };

    await finalizer(telegramRow, outcome);
    await finalizer(s3Row, outcome);

    expect(moderationAudit).toHaveBeenCalledTimes(1);
    expect(integration).toHaveBeenCalledTimes(1);
  });
});

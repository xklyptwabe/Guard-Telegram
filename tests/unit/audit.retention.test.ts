import { describe, expect, it } from 'vitest';

import { purgeExpiredAuditEventsBatch, runAuditRetentionJob } from '../../src/db/retention.js';
import type { AuditService } from '../../src/lib/auditService.js';

describe('audit retention batch job', () => {
  it('returns ids deleted by one limited batch', async () => {
    const db = {
      execute: async () => ({ rows: [{ id: 'event-1', retention_days: 30 }, { id: 'event-2', retention_days: 90 }] }),
    };

    await expect(
      purgeExpiredAuditEventsBatch(db as never, {
        batchSize: 2,
        now: new Date('2026-08-06T10:00:00.000Z'),
      }),
    ).resolves.toEqual({ deletedCount: 2, deletedEventIds: ['event-1', 'event-2'], retentionDays: 30 });
  });

  it('rejects invalid batch sizes', async () => {
    await expect(purgeExpiredAuditEventsBatch({ execute: async () => ({ rows: [] }) } as never, { batchSize: 0 })).rejects.toThrow(
      'Audit retention batchSize must be a positive integer.',
    );
  });

  it('records audit.retention.completed after the batch cleanup', async () => {
    const tx = {
      execute: async () => ({ rows: [{ id: 'event-1', retention_days: 30 }] }),
    };
    const audit = fakeAuditService(tx);

    await expect(
      runAuditRetentionJob(audit as unknown as AuditService, {
        jobId: 'job-1',
        idempotencyKey: 'retention-job-1',
        batchSize: 1,
        now: new Date('2026-08-06T10:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      jobId: 'job-1',
      deletedCount: 1,
      deletedEventIds: ['event-1'],
      retentionDays: 30,
      auditEventId: 'audit-event-1',
      duplicate: false,
    });

    expect(audit.calls.input).toMatchObject({
      eventType: 'audit.retention.completed',
      eventVersion: 'v1',
      subjectType: 'audit_retention_job',
      subjectId: 'job-1',
      idempotencyKey: 'retention-job-1',
    });
    expect(audit.calls.mutation).toMatchObject({
      after: {
        jobId: 'job-1',
        deletedCount: 1,
        retentionDays: 30,
        batchSize: 1,
        startedAt: '2026-08-06T10:00:00.000Z',
      },
      snapshotData: {
        jobId: 'job-1',
        deletedCount: 1,
        retentionDays: 30,
        batchSize: 1,
      },
    });
  });
});

function fakeAuditService(tx: { readonly execute: () => Promise<{ readonly rows: readonly Record<string, unknown>[] }> }) {
  const calls: { input?: unknown; mutation?: unknown } = {};
  return {
    calls,
    recordEntityChange: async (input: unknown, mutate: (transaction: typeof tx, nextSubjectSequence: number) => Promise<unknown>) => {
      calls.input = input;
      calls.mutation = await mutate(tx, 1);
      return { eventId: 'audit-event-1', subjectSequence: 1, duplicate: false };
    },
  };
}

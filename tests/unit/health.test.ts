import { describe, expect, it, vi } from 'vitest';

import { healthSnapshot, type AuditHealthSource } from '../../src/lib/health.js';
import type { Logger } from '../../src/lib/logger.js';

const config = {
  telegramTransport: 'long_polling',
  redisEnabled: false,
  s3Enabled: false,
  rabbitMqEnabled: false,
} as const;
const redis = { isAvailable: () => true } as never;
const storage = { enabled: false } as never;
const rabbitMq = { enabled: false } as never;

describe('health snapshot', () => {
  it('returns safe aggregate audit state without business data', async () => {
    const snapshot = await healthSnapshot(config, redis, storage, rabbitMq, auditSource());
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.status).toBe('ok');
    expect(snapshot.audit).toEqual({
      status: 'ready',
      recentWriteFailure: false,
      delivery: { pending: 2, failed: 0, oldestPendingAgeSeconds: 30 },
      externalOperations: {
        pending: 1,
        inProgress: 0,
        retryScheduled: 0,
        auditPending: 0,
        terminalUnknown: 0,
        oldestUnfinishedAgeSeconds: 10,
      },
    });
    expect(serialized).not.toMatch(/before|after|metadata|payload|telegram|chatId|tenantId|subjectId|correlationId|idempotency/i);
  });

  it('degrades for audit debt, stale work, or a recent write failure', async () => {
    const withDebt = auditSource({ auditPending: 1 });
    const withStaleWork = auditSource({ oldestUnfinishedAgeSeconds: 300 });
    const withWriteFailure = auditSource({}, true);

    await expect(healthSnapshot(config, redis, storage, rabbitMq, withDebt)).resolves.toMatchObject({
      status: 'degraded',
      audit: { status: 'degraded' },
    });
    await expect(healthSnapshot(config, redis, storage, rabbitMq, withStaleWork)).resolves.toMatchObject({
      status: 'degraded',
      audit: { status: 'degraded' },
    });
    await expect(healthSnapshot(config, redis, storage, rabbitMq, withWriteFailure)).resolves.toMatchObject({
      status: 'degraded',
      audit: { status: 'degraded', recentWriteFailure: true },
    });
  });

  it('reports unavailable aggregates safely when the database query fails', async () => {
    const logger = { error: vi.fn() } as unknown as Logger;
    const source = auditSource();
    source.readOperationalState = vi.fn().mockRejectedValue(new Error('postgres unavailable'));

    const snapshot = await healthSnapshot(config, redis, storage, rabbitMq, source, logger);

    expect(snapshot).toMatchObject({
      status: 'unhealthy',
      database: 'unhealthy',
      audit: {
        status: 'unhealthy',
        delivery: { pending: null, failed: null },
        externalOperations: { pending: null, auditPending: null },
      },
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

function auditSource(
  externalOverrides: Partial<{
    pending: number;
    inProgress: number;
    retryScheduled: number;
    auditPending: number;
    terminalUnknown: number;
    oldestUnfinishedAgeSeconds: number | null;
  }> = {},
  recentWriteFailure = false,
): AuditHealthSource {
  return {
    hasRecentWriteFailure: () => recentWriteFailure,
    readOperationalState: async () => ({
      delivery: { pending: 2, failed: 0, oldestPendingAgeSeconds: 30 },
      externalOperations: {
        pending: 1,
        inProgress: 0,
        retryScheduled: 0,
        auditPending: 0,
        terminalUnknown: 0,
        oldestUnfinishedAgeSeconds: 10,
        ...externalOverrides,
      },
    }),
  };
}

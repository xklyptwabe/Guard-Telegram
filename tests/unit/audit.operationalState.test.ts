import { describe, expect, it } from 'vitest';

import { readAuditOperationalState } from '../../src/lib/audit/operationalState.js';

describe('audit operational state', () => {
  it('summarizes both outbox models and calculates bounded ages', async () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    const state = await readAuditOperationalState(
      sequenceDatabase([
        [
          { status: 'pending', count: 3, oldestCreatedAt: '2026-08-28T11:58:00.000Z' },
          { status: 'failed', count: 1, oldestCreatedAt: '2026-08-28T11:50:00.000Z' },
        ],
        [
          { status: 'pending', count: 2, oldestCreatedAt: '2026-08-28T11:59:30.000Z' },
          { status: 'in_progress', count: 1, oldestCreatedAt: '2026-08-28T11:59:00.000Z' },
          { status: 'unknown', count: 4, oldestCreatedAt: '2026-08-28T11:55:00.000Z' },
        ],
        [{ count: 5, oldestCreatedAt: '2026-08-28T11:57:00.000Z' }],
        [{ count: 6, oldestCreatedAt: '2026-08-28T11:40:00.000Z' }],
      ]) as never,
      now,
    );

    expect(state).toEqual({
      delivery: { pending: 3, failed: 1, oldestPendingAgeSeconds: 120 },
      externalOperations: {
        pending: 2,
        inProgress: 1,
        retryScheduled: 4,
        auditPending: 5,
        terminalUnknown: 6,
        oldestUnfinishedAgeSeconds: 300,
      },
    });
  });

  it('returns zero counts and null ages for empty queues', async () => {
    const state = await readAuditOperationalState(sequenceDatabase([[], [], [], []]) as never);

    expect(state).toEqual({
      delivery: { pending: 0, failed: 0, oldestPendingAgeSeconds: null },
      externalOperations: {
        pending: 0,
        inProgress: 0,
        retryScheduled: 0,
        auditPending: 0,
        terminalUnknown: 0,
        oldestUnfinishedAgeSeconds: null,
      },
    });
  });
});

function sequenceDatabase(results: readonly (readonly Record<string, unknown>[])[]) {
  let queryIndex = 0;
  return {
    select() {
      const rows = results[queryIndex++] ?? [];
      return {
        from() {
          const query = {
            where() {
              return query;
            },
            groupBy() {
              return Promise.resolve(rows);
            },
            then(onFulfilled: (value: typeof rows) => unknown, onRejected?: (error: unknown) => unknown) {
              return Promise.resolve(rows).then(onFulfilled, onRejected);
            },
          };
          return query;
        },
      };
    },
  };
}

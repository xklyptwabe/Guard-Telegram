import { describe, expect, it } from 'vitest';

import { purgeExpiredAuditEventsBatch } from '../../src/db/retention.js';

describe('audit retention batch job', () => {
  it('returns ids deleted by one limited batch', async () => {
    const db = {
      execute: async () => ({ rows: [{ id: 'event-1' }, { id: 'event-2' }] }),
    };

    await expect(
      purgeExpiredAuditEventsBatch(db as never, {
        batchSize: 2,
        now: new Date('2026-08-06T10:00:00.000Z'),
      }),
    ).resolves.toEqual({ deletedCount: 2, deletedEventIds: ['event-1', 'event-2'] });
  });

  it('rejects invalid batch sizes', async () => {
    await expect(purgeExpiredAuditEventsBatch({ execute: async () => ({ rows: [] }) } as never, { batchSize: 0 })).rejects.toThrow(
      'Audit retention batchSize must be a positive integer.',
    );
  });
});

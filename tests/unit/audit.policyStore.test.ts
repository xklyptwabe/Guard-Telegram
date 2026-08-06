import { describe, expect, it } from 'vitest';

import {
  AuditPolicyOptimisticLockError,
  updateAuditPolicyWithLock,
  type UpdatedAuditPolicy,
} from '../../src/lib/audit/policyStore.js';

describe('audit policy store optimistic locking', () => {
  it('increments lockVersion when the expected version matches', async () => {
    const updatedAt = new Date('2026-08-06T10:00:00.000Z');
    const db = fakeUpdateDb([{ policyId: 'policy-1', lockVersion: 3, updatedAt }]);

    await expect(
      updateAuditPolicyWithLock(db as never, {
        policyId: 'policy-1',
        expectedLockVersion: 2,
        patch: { enabled: false, retentionDays: 90 },
      }),
    ).resolves.toEqual({ policyId: 'policy-1', lockVersion: 3, updatedAt });

    expect(db.calls.set).toEqual(
      expect.objectContaining({
        enabled: false,
        retentionDays: 90,
      }),
    );
  });

  it('throws an optimistic lock error when no row matches policyId and lockVersion', async () => {
    const db = fakeUpdateDb([]);

    await expect(
      updateAuditPolicyWithLock(db as never, {
        policyId: 'policy-1',
        expectedLockVersion: 2,
        patch: { enabled: true },
      }),
    ).rejects.toThrow(AuditPolicyOptimisticLockError);
  });
});

function fakeUpdateDb(rows: readonly UpdatedAuditPolicy[]) {
  const calls: { set?: unknown; where?: unknown; returning?: unknown } = {};
  return {
    calls,
    update: () => ({
      set(value: unknown) {
        calls.set = value;
        return {
          where(condition: unknown) {
            calls.where = condition;
            return {
              returning(selection: unknown) {
                calls.returning = selection;
                return Promise.resolve(rows);
              },
            };
          },
        };
      },
    }),
  };
}

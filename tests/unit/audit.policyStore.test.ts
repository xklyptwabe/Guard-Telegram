import { describe, expect, it } from 'vitest';

import {
  AuditPolicyOptimisticLockError,
  ProtectedAuditPolicyDisableError,
  updateAuditPolicyWithLock,
  type UpdatedAuditPolicy,
} from '../../src/lib/audit/policyStore.js';

describe('audit policy store optimistic locking', () => {
  it('increments lockVersion when the expected version matches', async () => {
    const updatedAt = new Date('2026-08-06T10:00:00.000Z');
    const db = fakePolicyDb({
      selectedPolicy: { eventType: 'message.deleted', eventVersion: 'v1' },
      updatedRows: [{ policyId: 'policy-1', lockVersion: 3, updatedAt }],
    });

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
    const db = fakePolicyDb({ updatedRows: [] });

    await expect(
      updateAuditPolicyWithLock(db as never, {
        policyId: 'policy-1',
        expectedLockVersion: 2,
        patch: { enabled: true },
      }),
    ).rejects.toThrow(AuditPolicyOptimisticLockError);
  });

  it('rejects attempts to disable protected event-type policies', async () => {
    const db = fakePolicyDb({
      selectedPolicy: { eventType: 'module.state.changed', eventVersion: 'v1' },
      updatedRows: [],
    });

    await expect(
      updateAuditPolicyWithLock(db as never, {
        policyId: 'global:event:module.state.changed:v1',
        expectedLockVersion: 1,
        patch: { enabled: false },
      }),
    ).rejects.toThrow(ProtectedAuditPolicyDisableError);

    expect(db.calls.set).toBeUndefined();
  });
});

function fakePolicyDb(options: {
  readonly selectedPolicy?: { readonly eventType: string | null; readonly eventVersion: string | null };
  readonly updatedRows: readonly UpdatedAuditPolicy[];
}) {
  const calls: { select?: unknown; set?: unknown; where?: unknown; returning?: unknown } = {};
  return {
    calls,
    select: (selection: unknown) => {
      calls.select = selection;
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(options.selectedPolicy === undefined ? [] : [options.selectedPolicy]),
          }),
        }),
      };
    },
    update: () => ({
      set(value: unknown) {
        calls.set = value;
        return {
          where(condition: unknown) {
            calls.where = condition;
            return {
              returning(selection: unknown) {
                calls.returning = selection;
                return Promise.resolve(options.updatedRows);
              },
            };
          },
        };
      },
    }),
  };
}

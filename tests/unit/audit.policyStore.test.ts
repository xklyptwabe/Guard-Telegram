import { describe, expect, it } from 'vitest';

import {
  AuditPolicyOptimisticLockError,
  ProtectedAuditPolicyDisableError,
  updateAuditPolicyWithAudit,
  updateAuditPolicyWithLock,
} from '../../src/lib/audit/policyStore.js';
import type { AuditService } from '../../src/lib/auditService.js';

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

  it('records successful policy updates through audit.policy.changed', async () => {
    const updatedAt = new Date('2026-08-06T10:00:00.000Z');
    const tx = fakePolicyDb({
      selectedPolicy: {
        policyId: 'global:event:message.deleted:v1',
        chatId: null,
        eventType: 'message.deleted',
        eventVersion: 'v1',
        moduleId: null,
        enabled: true,
        siteVisible: null,
        snapshotMode: null,
        allowlist: null,
        masking: null,
        retentionDays: null,
        severity: null,
        exportAllowed: null,
        lockVersion: 2,
        updatedAt,
      },
      updatedRows: [
        {
          policyId: 'global:event:message.deleted:v1',
          chatId: null,
          eventType: 'message.deleted',
          eventVersion: 'v1',
          moduleId: null,
          enabled: false,
          siteVisible: null,
          snapshotMode: null,
          allowlist: null,
          masking: null,
          retentionDays: 90,
          severity: null,
          exportAllowed: null,
          lockVersion: 3,
          updatedAt,
        },
      ],
    });
    const audit = fakeAuditService(tx);

    await expect(
      updateAuditPolicyWithAudit(audit as unknown as AuditService, {
        policyId: 'global:event:message.deleted:v1',
        expectedLockVersion: 2,
        patch: { enabled: false, retentionDays: 90 },
        idempotencyKey: 'audit-policy-change-1',
      }),
    ).resolves.toEqual({
      policyId: 'global:event:message.deleted:v1',
      lockVersion: 3,
      updatedAt,
      auditEventId: 'event-1',
      duplicate: false,
    });

    expect(audit.calls.input).toMatchObject({
      eventType: 'audit.policy.changed',
      eventVersion: 'v1',
      subjectType: 'audit_policy',
      subjectId: 'global:event:message.deleted:v1',
      idempotencyKey: 'audit-policy-change-1',
    });
    expect(audit.calls.mutation).toMatchObject({
      before: { enabled: true, retentionDays: null, lockVersion: 2 },
      after: { enabled: false, retentionDays: 90, lockVersion: 3 },
      snapshotData: { enabled: false, retentionDays: 90, lockVersion: 3 },
    });
  });
});

function fakePolicyDb(options: {
  readonly selectedPolicy?: Record<string, unknown>;
  readonly updatedRows: readonly Record<string, unknown>[];
}) {
  const calls: { select?: unknown; set?: unknown; where?: unknown; returning?: unknown } = {};
  return {
    calls,
    select: (selection: unknown) => {
      calls.select = selection;
      return {
        from: () => ({
          where: () => ({
            limit: () => oneRowResult(options.selectedPolicy === undefined ? [] : [options.selectedPolicy]),
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

function oneRowResult(rows: readonly Record<string, unknown>[]) {
  return Object.assign(Promise.resolve(rows), {
    for: (_lock: 'update') => Promise.resolve(rows),
  });
}

function fakeAuditService(tx: ReturnType<typeof fakePolicyDb>) {
  const calls: { input?: unknown; mutation?: unknown } = {};
  return {
    calls,
    recordEntityChange: async (input: unknown, mutate: (transaction: unknown, nextSubjectSequence: number) => Promise<unknown>) => {
      calls.input = input;
      calls.mutation = await mutate(tx, 1);
      return { eventId: 'event-1', subjectSequence: 1, duplicate: false };
    },
  };
}

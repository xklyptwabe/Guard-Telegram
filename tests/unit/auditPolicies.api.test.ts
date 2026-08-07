import { describe, expect, it } from 'vitest';

import { handleAuditPolicyWriteRequest } from '../../src/api/auditPolicies.js';
import type { BackendApiPrincipal } from '../../src/api/access.js';
import type { AuditPolicyReadRow } from '../../src/lib/audit/eventReadRepository.js';
import type { AuditService } from '../../src/lib/auditService.js';

const managerPrincipal: BackendApiPrincipal = {
  actorId: 'operator-1',
  permissions: ['audit.policies.manage'],
  allowedChatIds: ['chat-1'],
  systemAdmin: false,
};

describe('audit policy write API', () => {
  it('updates an accessible policy through the audited policy store', async () => {
    const updatedAt = new Date('2026-08-07T10:00:00.000Z');
    const db = fakePolicyApiDb({ policies: [policyRow({ lockVersion: 2 })] });
    const tx = fakePolicyTx({
      selectedPolicy: policySnapshot({ lockVersion: 2, updatedAt }),
      updatedRows: [policySnapshot({ enabled: false, lockVersion: 3, updatedAt })],
    });
    const audit = fakeAuditService(tx);

    const response = await handleAuditPolicyWriteRequest(
      'PATCH',
      url('/api/v1/audit/policies/chat%3Achat-1%3Aevent%3Amessage.deleted%3Av1'),
      {
        expectedLockVersion: 2,
        idempotencyKey: 'backend-api-policy-update-1',
        enabled: false,
        retentionDays: 90,
      },
      managerPrincipal,
      { db: db as never, audit: audit as unknown as AuditService },
    );

    expect(response?.statusCode).toBe(200);
    expect(response?.body).toEqual({
      item: {
        policyId: 'chat:chat-1:event:message.deleted:v1',
        lockVersion: 3,
        updatedAt: '2026-08-07T10:00:00.000Z',
        auditEventId: 'event-1',
        duplicate: false,
      },
    });
    expect(audit.calls.input).toMatchObject({
      actorId: 'operator-1',
      eventType: 'audit.policy.changed',
      idempotencyKey: 'backend-api-policy-update-1',
      subjectId: 'chat:chat-1:event:message.deleted:v1',
      tenantId: 'chat-1',
    });
    expect(tx.calls.set).toMatchObject({ enabled: false, retentionDays: 90 });
  });

  it('does not allow read-only principals to update policies', async () => {
    const response = await handleAuditPolicyWriteRequest(
      'PATCH',
      url('/api/v1/audit/policies/chat%3Achat-1%3Aevent%3Amessage.deleted%3Av1'),
      { expectedLockVersion: 2, idempotencyKey: 'backend-api-policy-update-2', enabled: false },
      { ...managerPrincipal, permissions: ['audit.events.read'] },
      { db: fakePolicyApiDb({ policies: [policyRow()] }) as never, audit: fakeAuditService(fakePolicyTx()) as unknown as AuditService },
    );

    expect(response?.statusCode).toBe(403);
  });

  it('does not reveal policies outside the principal chat scope', async () => {
    const audit = fakeAuditService(fakePolicyTx());
    const response = await handleAuditPolicyWriteRequest(
      'PATCH',
      url('/api/v1/audit/policies/chat%3Achat-2%3Aevent%3Amessage.deleted%3Av1'),
      { expectedLockVersion: 2, idempotencyKey: 'backend-api-policy-update-3', enabled: false },
      managerPrincipal,
      { db: fakePolicyApiDb({ policies: [] }) as never, audit: audit as unknown as AuditService },
    );

    expect(response?.statusCode).toBe(404);
    expect(response?.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect(audit.calls.input).toBeUndefined();
  });

  it('returns a conflict when lockVersion is stale', async () => {
    const tx = fakePolicyTx({
      selectedPolicy: policySnapshot({ lockVersion: 3 }),
      updatedRows: [],
    });
    const response = await handleAuditPolicyWriteRequest(
      'PATCH',
      url('/api/v1/audit/policies/chat%3Achat-1%3Aevent%3Amessage.deleted%3Av1'),
      { expectedLockVersion: 2, idempotencyKey: 'backend-api-policy-update-4', enabled: false },
      managerPrincipal,
      {
        db: fakePolicyApiDb({ policies: [policyRow({ lockVersion: 3 })] }) as never,
        audit: fakeAuditService(tx) as unknown as AuditService,
      },
    );

    expect(response?.statusCode).toBe(409);
    expect(response?.body).toMatchObject({ error: { code: 'optimistic_lock_conflict' } });
  });

  it('rejects empty patches', async () => {
    const response = await handleAuditPolicyWriteRequest(
      'PATCH',
      url('/api/v1/audit/policies/chat%3Achat-1%3Aevent%3Amessage.deleted%3Av1'),
      { expectedLockVersion: 2, idempotencyKey: 'backend-api-policy-update-5' },
      managerPrincipal,
      { db: fakePolicyApiDb({ policies: [policyRow()] }) as never, audit: fakeAuditService(fakePolicyTx()) as unknown as AuditService },
    );

    expect(response?.statusCode).toBe(400);
  });
});

function url(path: string): URL {
  return new URL(path, 'http://backend-api.local');
}

function fakePolicyApiDb(options: { readonly policies: readonly AuditPolicyReadRow[] }) {
  const calls: { select?: unknown } = {};
  return {
    calls,
    select(selection: unknown) {
      calls.select = selection;
      const query = {
        from: () => query,
        where: () => query,
        limit: async (limit: number) => options.policies.slice(0, limit),
      };
      return query;
    },
  };
}

function fakePolicyTx(
  options: {
    readonly selectedPolicy?: Record<string, unknown>;
    readonly updatedRows?: readonly Record<string, unknown>[];
  } = {},
) {
  const selectedPolicy = options.selectedPolicy ?? policySnapshot({ lockVersion: 2 });
  const calls: { set?: unknown } = {};
  return {
    calls,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => oneRowResult([selectedPolicy]),
        }),
      }),
    }),
    update: () => ({
      set(value: unknown) {
        calls.set = value;
        return {
          where: () => ({
            returning: async () => options.updatedRows ?? [policySnapshot({ lockVersion: 3 })],
          }),
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

function fakeAuditService(tx: ReturnType<typeof fakePolicyTx>) {
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

function policyRow(overrides: Partial<AuditPolicyReadRow> = {}): AuditPolicyReadRow {
  return {
    policyId: 'chat:chat-1:event:message.deleted:v1',
    chatId: 'chat-1',
    eventType: 'message.deleted',
    eventVersion: 'v1',
    moduleId: null,
    required: true,
    retentionDays: null,
    enabled: true,
    siteVisible: true,
    snapshotMode: 'metadata',
    allowlist: null,
    masking: null,
    severity: 'warning',
    exportAllowed: true,
    lockVersion: 2,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function policySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyId: 'chat:chat-1:event:message.deleted:v1',
    chatId: 'chat-1',
    eventType: 'message.deleted',
    eventVersion: 'v1',
    moduleId: null,
    enabled: true,
    siteVisible: true,
    snapshotMode: 'metadata',
    allowlist: null,
    masking: null,
    retentionDays: null,
    severity: 'warning',
    exportAllowed: true,
    lockVersion: 2,
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

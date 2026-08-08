import { describe, expect, it } from 'vitest';

import { handleAuditExportRequest } from '../../src/api/auditExports.js';
import type { BackendApiPrincipal } from '../../src/api/access.js';
import type { AuditEventReadRow } from '../../src/lib/audit/eventReadRepository.js';
import type { AuditPolicyResolutionRow } from '../../src/lib/audit/policyResolution.js';
import type { AuditService } from '../../src/lib/auditService.js';

const exportPrincipal: BackendApiPrincipal = {
  actorId: 'operator-1',
  permissions: ['audit.exports.create'],
  allowedChatIds: ['chat-1'],
  systemAdmin: false,
};

describe('audit export API', () => {
  it('creates an audit export', async () => {
    const audit = fakeAuditService();
    const response = await handleAuditExportRequest(
      'POST',
      url('/api/v1/audit/exports'),
      {
        format: 'json',
        filters: {
          chatIds: ['chat-1'],
          eventTypes: ['message.deleted'],
          categories: ['message'],
        },
        limit: 10,
      },
      exportPrincipal,
      {
        db: fakeExportDb({
          events: [eventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
          policies: [policyRow({ exportAllowed: true, enabled: true })],
        }) as never,
        audit: audit as unknown as AuditService,
      },
    );

    expect(response?.statusCode).toBe(201);
    expect(response?.body).toMatchObject({
      item: {
        format: 'json',
        contentType: 'application/json',
        rowCount: 1,
        truncated: false,
        auditEventId: 'audit-event-1',
      },
    });
    expect(audit.calls.input).toMatchObject({ eventType: 'audit.exported' });
  });

  it('does not allow read-only principals to export audit events', async () => {
    const response = await handleAuditExportRequest(
      'POST',
      url('/api/v1/audit/exports'),
      { format: 'json', filters: {} },
      { ...exportPrincipal, permissions: ['audit.events.read'] },
      { db: fakeExportDb({ events: [], policies: [] }) as never, audit: fakeAuditService() as unknown as AuditService },
    );

    expect(response?.statusCode).toBe(403);
  });

  it('returns forbidden when an export policy blocks a selected row', async () => {
    const audit = fakeAuditService();
    const response = await handleAuditExportRequest(
      'POST',
      url('/api/v1/audit/exports'),
      { format: 'csv', filters: { chatIds: ['chat-1'] } },
      exportPrincipal,
      {
        db: fakeExportDb({
          events: [eventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
          policies: [policyRow({ exportAllowed: false, enabled: true })],
        }) as never,
        audit: audit as unknown as AuditService,
      },
    );

    expect(response?.statusCode).toBe(403);
    expect(audit.calls.input).toBeUndefined();
  });

  it('rejects malformed export requests', async () => {
    const response = await handleAuditExportRequest(
      'POST',
      url('/api/v1/audit/exports'),
      { format: 'xml', filters: {} },
      exportPrincipal,
      { db: fakeExportDb({ events: [], policies: [] }) as never, audit: fakeAuditService() as unknown as AuditService },
    );

    expect(response?.statusCode).toBe(400);
  });
});

function url(path: string): URL {
  return new URL(path, 'http://backend-api.local');
}

function fakeExportDb(options: {
  readonly events: readonly AuditEventReadRow[];
  readonly policies: readonly AuditPolicyResolutionRow[];
}) {
  return {
    select(selection: Record<string, unknown>) {
      if ('policyId' in selection) {
        return { from: async () => options.policies };
      }
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async (limit: number) => options.events.slice(0, limit),
      };
      return query;
    },
  };
}

function fakeAuditService() {
  const calls: { input?: unknown; mutation?: unknown } = {};
  return {
    calls,
    recordEntityChange: async (input: unknown, mutate: () => Promise<unknown>) => {
      calls.input = input;
      calls.mutation = await mutate();
      return { eventId: 'audit-event-1', subjectSequence: 1, duplicate: false };
    },
  };
}

function eventRow(id: string): AuditEventReadRow {
  const occurredAt = new Date('2026-08-07T10:00:00.000Z');
  return {
    id,
    eventType: 'message.deleted',
    eventVersion: 'v1',
    category: 'message',
    occurredAt,
    recordedAt: occurredAt,
    source: 'telegram.command',
    status: 'recorded',
    tenantId: 'chat-1',
    actorId: 'operator-1',
    actorType: 'telegram_user',
    subjectType: 'message',
    subjectId: 'chat-1:message-1',
    subjectSequence: 1,
    correlationId: 'corr-1',
    telegramContext: { chatId: 'chat-1' },
    before: null,
    after: null,
    beforeSnapshotStatus: 'not_observed',
    afterSnapshotStatus: 'observed',
    changes: null,
    metadata: null,
  };
}

function policyRow(values: Partial<AuditPolicyResolutionRow>): AuditPolicyResolutionRow {
  return {
    policyId: 'chat:chat-1:event:message.deleted:v1',
    chatId: 'chat-1',
    eventType: 'message.deleted',
    eventVersion: 'v1',
    moduleId: null,
    enabled: null,
    siteVisible: null,
    snapshotMode: null,
    allowlist: null,
    masking: null,
    retentionDays: null,
    severity: null,
    exportAllowed: null,
    ...values,
  };
}

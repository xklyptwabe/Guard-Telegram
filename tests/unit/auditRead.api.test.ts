import { describe, expect, it } from 'vitest';

import { handleAuditReadRequest } from '../../src/api/auditRead.js';
import type { BackendApiPrincipal } from '../../src/api/access.js';
import {
  encodeAuditEventsCursor,
  type AuditEventReadRow,
  type AuditEventTypeReadRow,
  type AuditPolicyReadRow,
} from '../../src/lib/audit/eventReadRepository.js';

const readPrincipal: BackendApiPrincipal = {
  actorId: 'operator-1',
  permissions: ['audit.events.read'],
  allowedChatIds: ['chat-1'],
  systemAdmin: false,
};

describe('audit read API', () => {
  it('lists audit events and returns a cursor when the repository has another row', async () => {
    const rows = [
      auditEventRow('cccccccc-cccc-cccc-cccc-cccccccccccc', new Date('2026-08-07T10:00:00.000Z')),
      auditEventRow('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', new Date('2026-08-07T09:00:00.000Z')),
    ];

    const response = await handleAuditReadRequest(
      'GET',
      url('/api/v1/audit/events?chatId=chat-1&eventType=message.deleted&category=message&limit=1'),
      readPrincipal,
      { db: fakeReadDb({ events: rows }) as never },
    );

    expect(response?.statusCode).toBe(200);
    expect(response?.body).toMatchObject({
      items: [
        {
          id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          occurredAt: '2026-08-07T10:00:00.000Z',
        },
      ],
    });
    expect(response?.body).toHaveProperty('nextCursor');
  });

  it('returns bad request for a cursor with a non-UUID id before querying the database', async () => {
    const cursor = encodeAuditEventsCursor({
      occurredAt: '2026-08-07 10:00:00.123456+00',
      id: 'not-a-uuid',
    });
    const db = {
      select: () => {
        throw new Error('database must not be queried for an invalid cursor');
      },
    };

    const response = await handleAuditReadRequest(
      'GET',
      url(`/api/v1/audit/events?cursor=${cursor}`),
      readPrincipal,
      { db: db as never },
    );

    expect(response).toEqual({
      statusCode: 400,
      body: { error: { code: 'bad_request', message: 'Audit events cursor is invalid.' } },
    });
  });

  it('returns a single event through the same read permission', async () => {
    const event = auditEventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', new Date('2026-08-07T10:00:00.000Z'));

    const response = await handleAuditReadRequest(
      'GET',
      url('/api/v1/audit/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      readPrincipal,
      { db: fakeReadDb({ events: [event] }) as never },
    );

    expect(response?.statusCode).toBe(200);
    expect(response?.body).toMatchObject({ item: { id: event.id, tenantId: 'chat-1' } });
  });

  it('keeps missing or inaccessible event ids indistinguishable', async () => {
    const response = await handleAuditReadRequest(
      'GET',
      url('/api/v1/audit/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      readPrincipal,
      { db: fakeReadDb() as never },
    );

    expect(response?.statusCode).toBe(404);
    expect(response?.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('lists event types', async () => {
    const response = await handleAuditReadRequest('GET', url('/api/v1/audit/event-types'), readPrincipal, {
      db: fakeReadDb({
        eventTypes: [
          {
            eventType: 'message.deleted',
            eventVersion: 'v1',
            category: 'message',
            description: null,
            severity: 'warning',
            siteVisible: true,
            canBeDisabled: true,
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
            updatedAt: new Date('2026-08-02T00:00:00.000Z'),
          },
        ],
      }) as never,
    });

    expect(response?.statusCode).toBe(200);
    expect(response?.body).toEqual({
      items: [
        {
          eventType: 'message.deleted',
          eventVersion: 'v1',
          category: 'message',
          description: null,
          severity: 'warning',
          siteVisible: true,
          canBeDisabled: true,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    });
  });

  it('lists visible policy rows available to the read scope', async () => {
    const response = await handleAuditReadRequest('GET', url('/api/v1/audit/policies'), readPrincipal, {
      db: fakeReadDb({
        policies: [
          {
            policyId: 'policy-chat-message',
            chatId: 'chat-1',
            eventType: 'message.deleted',
            eventVersion: 'v1',
            moduleId: null,
            required: true,
            retentionDays: 90,
            enabled: true,
            siteVisible: true,
            snapshotMode: 'metadata',
            allowlist: null,
            masking: null,
            severity: 'warning',
            exportAllowed: true,
            lockVersion: 3,
            createdAt: new Date('2026-08-01T00:00:00.000Z'),
            updatedAt: new Date('2026-08-02T00:00:00.000Z'),
          },
        ],
      }) as never,
    });

    expect(response?.statusCode).toBe(200);
    expect(response?.body).toMatchObject({
      items: [
        {
          policyId: 'policy-chat-message',
          chatId: 'chat-1',
          updatedAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    });
  });

  it('does not treat read permission as a state-changing route permission', async () => {
    const response = await handleAuditReadRequest(
      'PATCH',
      url('/api/v1/audit/policies/policy-chat-message'),
      readPrincipal,
      { db: fakeReadDb() as never },
    );

    expect(response).toBeUndefined();
  });

  it('rejects read routes without audit.events.read', async () => {
    const response = await handleAuditReadRequest(
      'GET',
      url('/api/v1/audit/events'),
      { ...readPrincipal, permissions: [] },
      { db: fakeReadDb() as never },
    );

    expect(response?.statusCode).toBe(403);
  });
});

function url(path: string): URL {
  return new URL(path, 'http://backend-api.local');
}

function fakeReadDb(
  rows: {
    readonly events?: readonly AuditEventReadRow[];
    readonly eventTypes?: readonly AuditEventTypeReadRow[];
    readonly policies?: readonly AuditPolicyReadRow[];
  } = {},
) {
  return {
    select(selection: Record<string, unknown>) {
      const selectedRows = selectedRowsFor(selection, rows);
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async (limit: number) => selectedRows.slice(0, limit),
        then<TResult1 = readonly unknown[], TResult2 = never>(
          onfulfilled?: ((value: readonly unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): Promise<TResult1 | TResult2> {
          return Promise.resolve(selectedRows).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  };
}

function selectedRowsFor(
  selection: Record<string, unknown>,
  rows: {
    readonly events?: readonly AuditEventReadRow[];
    readonly eventTypes?: readonly AuditEventTypeReadRow[];
    readonly policies?: readonly AuditPolicyReadRow[];
  },
): readonly unknown[] {
  if ('policyId' in selection) return rows.policies ?? [];
  if ('canBeDisabled' in selection) return rows.eventTypes ?? [];
  return rows.events ?? [];
}

function auditEventRow(id: string, occurredAt: Date): AuditEventReadRow {
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
    actorType: 'operator',
    subjectType: 'message',
    subjectId: 'chat-1:message-1',
    subjectSequence: 1,
    correlationId: 'corr-1',
    telegramContext: { chatId: 'chat-1', messageThreadId: '42' },
    before: null,
    after: null,
    beforeSnapshotStatus: 'not_observed',
    afterSnapshotStatus: 'observed',
    changes: null,
    metadata: { moduleId: 'moderation' },
  };
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import * as auditSchema from '../../src/db/schema/audit.js';
import {
  AuditEventsCursorError,
  buildAuditEventByIdQuery,
  buildAuditEventsListQuery,
  buildAuditPoliciesListQuery,
  decodeAuditEventsCursor,
  encodeAuditEventsCursor,
  isAuditEventRowPastCursor,
  listAuditEvents,
  type AuditEventReadRow,
} from '../../src/lib/audit/eventReadRepository.js';

const db = drizzle.mock({ schema: auditSchema });

describe('audit event read repository', () => {
  it('builds a bounded query with every supported filter and allowed-chat intersection', () => {
    const query = buildAuditEventsListQuery(
      db,
      {
        scope: { systemAdmin: false, allowedChatIds: ['chat-1', 'chat-2'] },
        limit: 25,
        filters: {
          occurredFrom: new Date('2026-08-01T00:00:00.000Z'),
          occurredTo: new Date('2026-08-07T00:00:00.000Z'),
          chatIds: ['chat-2', 'chat-3'],
          topicId: '42',
          actorId: 'user-1',
          eventTypes: ['message.deleted'],
          categories: ['message'],
          moduleId: 'moderation',
          source: 'telegram.command',
          status: 'recorded',
          subjectType: 'message',
          subjectId: 'chat-2:message-1',
          correlationId: 'corr-1',
        },
      },
    ).toSQL();

    expect(query.sql).toContain('"audit"."events"."tenant_id" = $1');
    expect(query.sql).toContain('"audit"."events"."occurred_at" >= $2');
    expect(query.sql).toContain('"audit"."events"."occurred_at" <= $3');
    expect(query.sql).toContain('"audit"."events"."telegram_context" #>> \'{messageThreadId}\'');
    expect(query.sql).toContain('"audit"."events"."telegram_context" #>> \'{message_thread_id}\'');
    expect(query.sql).toContain('"audit"."events"."actor_id" = $6');
    expect(query.sql).toContain('"audit"."events"."event_type" = $7');
    expect(query.sql).toContain('"audit"."events"."category" = $8');
    expect(query.sql).toContain('"audit"."events"."metadata" #>> \'{moduleId}\'');
    expect(query.sql).toContain('"audit"."events"."before" #>> \'{moduleId}\'');
    expect(query.sql).toContain('"audit"."events"."after" #>> \'{moduleId}\'');
    expect(query.sql).toContain('"audit"."events"."source" = $12');
    expect(query.sql).toContain('"audit"."events"."status" = $13');
    expect(query.sql).toContain('"audit"."events"."subject_type" = $14');
    expect(query.sql).toContain('"audit"."events"."subject_id" = $15');
    expect(query.sql).toContain('"audit"."events"."correlation_id" = $16');
    expect(query.sql).toContain('order by "audit"."events"."occurred_at" desc, "audit"."events"."id" desc');
    expect(query.sql).toContain('limit $17');
    expect(query.params).toEqual([
      'chat-2',
      '2026-08-01T00:00:00.000Z',
      '2026-08-07T00:00:00.000Z',
      '42',
      '42',
      'user-1',
      'message.deleted',
      'message',
      'moderation',
      'moderation',
      'moderation',
      'telegram.command',
      'recorded',
      'message',
      'chat-2:message-1',
      'corr-1',
      26,
    ]);
  });

  it('returns no rows for non-system principals without allowed chats', () => {
    const query = buildAuditEventsListQuery(
      db,
      {
        scope: { systemAdmin: false, allowedChatIds: [] },
      },
    ).toSQL();

    expect(query.sql).toContain('where FALSE');
  });

  it('does not restrict tenant scope for system administrators unless a chat filter is requested', () => {
    const query = buildAuditEventsListQuery(
      db,
      {
        scope: { systemAdmin: true, allowedChatIds: [] },
      },
    ).toSQL();

    expect(query.sql).not.toMatch(/where[\s\S]*"tenant_id"/);
  });

  it('scopes single-event reads by id to the principal chats', () => {
    const query = buildAuditEventByIdQuery(db, {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      scope: { systemAdmin: false, allowedChatIds: ['chat-1', 'chat-2'] },
    }).toSQL();

    expect(query.sql).toContain('"audit"."events"."id" = $1');
    expect(query.sql).toContain('"audit"."events"."tenant_id" in ($2, $3)');
    expect(query.params).toEqual(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'chat-1', 'chat-2', 1]);
  });

  it('does not expose global policies to non-system principals', () => {
    const query = buildAuditPoliciesListQuery(db, {
      systemAdmin: false,
      allowedChatIds: ['chat-1'],
    }).toSQL();

    expect(query.sql).toContain('"audit"."event_policies"."chat_id" = $1');
    expect(query.params).toEqual(['chat-1']);
  });

  it('allows system administrators to read global policies', () => {
    const query = buildAuditPoliciesListQuery(db, {
      systemAdmin: true,
      allowedChatIds: [],
    }).toSQL();

    expect(query.sql).not.toMatch(/where[\s\S]*"chat_id"/);
  });

  it('encodes cursor pagination as occurred_at plus id for descending order', () => {
    const cursor = encodeAuditEventsCursor({
      occurredAt: new Date('2026-08-06T10:00:00.000Z'),
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    const query = buildAuditEventsListQuery(
      db,
      {
        scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
        cursor,
      },
    ).toSQL();

    expect(decodeAuditEventsCursor(cursor)).toEqual({
      occurredAt: new Date('2026-08-06T10:00:00.000Z'),
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    });
    expect(query.sql).toContain('"audit"."events"."occurred_at" < $2::timestamptz');
    expect(query.sql).toContain('"audit"."events"."occurred_at" = $3 and "audit"."events"."id" < $4::uuid');
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeAuditEventsCursor('not-base64-json')).toThrow(AuditEventsCursorError);
  });

  it('uses the same cursor boundary semantics without duplicates or gaps for equal timestamps', () => {
    const occurredAt = new Date('2026-08-06T10:00:00.000Z');
    const rows = [
      row('dddddddd-dddd-dddd-dddd-dddddddddddd', occurredAt),
      row('cccccccc-cccc-cccc-cccc-cccccccccccc', occurredAt),
      row('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', occurredAt),
      row('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', new Date('2026-08-06T09:59:00.000Z')),
    ];
    const firstPage = rows.slice(0, 2);
    const cursor = { occurredAt: firstPage[1]!.occurredAt, id: firstPage[1]!.id };
    const secondPage = rows.filter((item) => isAuditEventRowPastCursor(item, cursor)).slice(0, 2);

    expect(firstPage.map((item) => item.id)).toEqual([
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
    ]);
    expect(secondPage.map((item) => item.id)).toEqual([
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
  });

  it('fetches one extra row to produce a next cursor', async () => {
    const rows = [
      row('cccccccc-cccc-cccc-cccc-cccccccccccc', new Date('2026-08-06T10:00:00.000Z')),
      row('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', new Date('2026-08-06T09:00:00.000Z')),
      row('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', new Date('2026-08-06T08:00:00.000Z')),
    ];
    const db = fakeAuditEventsDb(rows);

    const page = await listAuditEvents(db as never, {
      scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
      limit: 2,
    });

    expect(page.items.map((item) => item.id)).toEqual([
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ]);
    expect(page.nextCursor).toBe(encodeAuditEventsCursor({ occurredAt: rows[1]!.occurredAt, id: rows[1]!.id }));
  });
});

function row(id: string, occurredAt: Date): AuditEventReadRow {
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
    actorId: null,
    actorType: null,
    subjectType: 'message',
    subjectId: `${id}:subject`,
    subjectSequence: 1,
    correlationId: null,
    telegramContext: null,
    before: null,
    after: null,
    beforeSnapshotStatus: 'not_observed',
    afterSnapshotStatus: 'observed',
    changes: null,
    metadata: null,
  };
}

function fakeAuditEventsDb(rows: readonly AuditEventReadRow[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
  };
}

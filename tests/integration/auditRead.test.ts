import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { handleAuditReadRequest } from '../../src/api/auditRead.js';
import type { BackendApiPrincipal } from '../../src/api/access.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import {
  AuditEventsCursorError,
  encodeAuditEventsCursor,
  listAuditEvents,
} from '../../src/lib/audit/eventReadRepository.js';
import { PLATFORM_TENANT_SENTINEL } from '../../src/lib/audit/serviceAdapter.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
let database: DatabaseClient | undefined;

const readPrincipal: BackendApiPrincipal = {
  actorId: 'audit-read-operator',
  permissions: ['audit.events.read'],
  allowedChatIds: ['audit-read-site-visible'],
  systemAdmin: false,
};

const systemAdminPrincipal: BackendApiPrincipal = {
  actorId: 'audit-read-system-admin',
  permissions: ['audit.events.read'],
  allowedChatIds: [],
  systemAdmin: true,
};

describe.skipIf(!testDatabaseUrl)('Audit read integration', () => {
  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: 'src/db/migrations' });
  });

  afterAll(async () => {
    await database?.close();
  });

  it('does not skip rows when occurred_at values differ below millisecond precision', async () => {
    const rollback = new Error('rollback audit read test');
    let pageIds: readonly string[] = [];

    try {
      await database!.db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO audit.events (
            id, event_type, event_version, category, occurred_at, source, status,
            tenant_id, subject_type, subject_id, idempotency_key,
            before_snapshot_status, after_snapshot_status
          ) VALUES
            ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'message.deleted', 'v1', 'message',
              '2026-08-07 10:00:00.123900+00'::timestamptz, 'audit-read-test', 'recorded',
              'audit-read-pagination', 'message', 'message-4', 'audit-read-pagination-4',
              'not_observed', 'observed'),
            ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'message.deleted', 'v1', 'message',
              '2026-08-07 10:00:00.123800+00'::timestamptz, 'audit-read-test', 'recorded',
              'audit-read-pagination', 'message', 'message-3', 'audit-read-pagination-3',
              'not_observed', 'observed'),
            ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'message.deleted', 'v1', 'message',
              '2026-08-07 10:00:00.123800+00'::timestamptz, 'audit-read-test', 'recorded',
              'audit-read-pagination', 'message', 'message-2', 'audit-read-pagination-2',
              'not_observed', 'observed'),
            ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'message.deleted', 'v1', 'message',
              '2026-08-07 10:00:00.123700+00'::timestamptz, 'audit-read-test', 'recorded',
              'audit-read-pagination', 'message', 'message-1', 'audit-read-pagination-1',
              'not_observed', 'observed')
        `);

        const scope = { systemAdmin: false, allowedChatIds: ['audit-read-pagination'] } as const;
        const first = await listAuditEvents(tx, { scope, limit: 2 });
        if (first.nextCursor === undefined) throw new Error('First page must have a cursor');
        const second = await listAuditEvents(tx, { scope, limit: 2, cursor: first.nextCursor });
        pageIds = [...first.items, ...second.items].map((event) => event.id);

        throw rollback;
      });
    } catch (error: unknown) {
      if (error !== rollback) throw error;
    }

    expect(pageIds).toEqual([
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });

  it('keeps platform audit hidden from non-system principals', async () => {
    const rollback = new Error('rollback platform audit read test');
    let nonSystemIds: readonly string[] = [];
    let systemIds: readonly string[] = [];

    try {
      await database!.db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO audit.events (
            id, event_type, event_version, category, occurred_at, source, status,
            tenant_id, subject_type, subject_id, idempotency_key,
            before_snapshot_status, after_snapshot_status
          ) VALUES (
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'audit.retention.completed', 'v1', 'audit',
            '2026-08-07 11:00:00+00'::timestamptz, 'audit-read-platform-test', 'recorded',
            ${PLATFORM_TENANT_SENTINEL}, 'retention_job', 'job-1', 'audit-read-platform-event',
            'not_applicable', 'observed'
          )
        `);

        const filters = { source: 'audit-read-platform-test' } as const;
        const nonSystemPage = await listAuditEvents(tx, {
          scope: { systemAdmin: false, allowedChatIds: [PLATFORM_TENANT_SENTINEL] },
          filters,
        });
        const systemPage = await listAuditEvents(tx, {
          scope: { systemAdmin: true, allowedChatIds: [] },
          filters,
        });
        nonSystemIds = nonSystemPage.items.map((event) => event.id);
        systemIds = systemPage.items.map((event) => event.id);

        throw rollback;
      });
    } catch (error: unknown) {
      if (error !== rollback) throw error;
    }

    expect(nonSystemIds).toEqual([]);
    expect(systemIds).toEqual(['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee']);
  });

  it('rejects a non-UUID cursor id before PostgreSQL casts it', async () => {
    const cursor = encodeAuditEventsCursor({
      occurredAt: '2026-08-07 10:00:00.123456+00',
      id: 'not-a-uuid',
    });

    await expect(
      listAuditEvents(database!.db, {
        scope: { systemAdmin: false, allowedChatIds: ['audit-read-pagination'] },
        cursor,
      }),
    ).rejects.toThrow(AuditEventsCursorError);
  });

  it('hides effective siteVisible=false from list and get without a system-admin bypass', async () => {
    const rollback = new Error('rollback site visibility API test');
    const eventId = 'a1111111-1111-4111-8111-111111111111';
    const missingId = 'a2222222-2222-4222-8222-222222222222';
    const policyId = 'integration:audit-read-site-visible';
    const source = 'audit-read-site-visible-test';

    try {
      await database!.db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO audit.events (
            id, event_type, event_version, category, occurred_at, source, status,
            tenant_id, subject_type, subject_id, idempotency_key,
            before_snapshot_status, after_snapshot_status
          ) VALUES (
            ${eventId}, 'message.deleted', 'v1', 'message',
            '2026-08-07 12:00:00+00'::timestamptz, ${source}, 'recorded',
            'audit-read-site-visible', 'message', 'message-hidden',
            'audit-read-site-visible-event', 'not_observed', 'observed'
          )
        `);

        const listHidden = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events?source=${source}`),
          readPrincipal,
          { db: tx as never },
        );
        const getHidden = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events/${eventId}`),
          readPrincipal,
          { db: tx as never },
        );
        const getMissing = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events/${missingId}`),
          readPrincipal,
          { db: tx as never },
        );
        const getHiddenAsSystemAdmin = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events/${eventId}`),
          systemAdminPrincipal,
          { db: tx as never },
        );

        expect(listHidden?.body).toEqual({ items: [] });
        expect(getHidden).toEqual(getMissing);
        expect(getHidden).toEqual({
          statusCode: 404,
          body: { error: { code: 'not_found', message: 'Not found' } },
        });
        expect(getHiddenAsSystemAdmin).toEqual(getHidden);

        await tx.execute(sql`
          INSERT INTO audit.event_policies (
            policy_id, chat_id, event_type, event_version, site_visible
          ) VALUES (${policyId}, 'audit-read-site-visible', 'message.deleted', 'v1', true)
        `);

        const getVisible = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events/${eventId}`),
          readPrincipal,
          { db: tx as never },
        );
        expect(getVisible?.statusCode).toBe(200);

        await tx.execute(sql`
          UPDATE audit.event_policies SET site_visible = false WHERE policy_id = ${policyId}
        `);
        const listHiddenAgain = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events?source=${source}`),
          readPrincipal,
          { db: tx as never },
        );
        expect(listHiddenAgain?.body).toEqual({ items: [] });

        throw rollback;
      });
    } catch (error: unknown) {
      if (error !== rollback) throw error;
    }
  });

  it('paginates only visible events when hidden rows share the same occurred_at', async () => {
    const rollback = new Error('rollback site visibility pagination test');
    const source = 'audit-read-site-visible-pagination-test';

    try {
      await database!.db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO audit.events (
            id, event_type, event_version, category, occurred_at, source, status,
            tenant_id, subject_type, subject_id, idempotency_key,
            before_snapshot_status, after_snapshot_status
          ) VALUES
            ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'command.executed', 'v1', 'command',
              '2026-08-07 13:00:00.123456+00'::timestamptz, ${source}, 'recorded',
              'audit-read-site-visible', 'command', 'visible-3', 'audit-read-site-visible-page-5',
              'not_observed', 'observed'),
            ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'message.deleted', 'v1', 'message',
              '2026-08-07 13:00:00.123456+00'::timestamptz, ${source}, 'recorded',
              'audit-read-site-visible', 'message', 'hidden-2', 'audit-read-site-visible-page-4',
              'not_observed', 'observed'),
            ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'command.executed', 'v1', 'command',
              '2026-08-07 13:00:00.123456+00'::timestamptz, ${source}, 'recorded',
              'audit-read-site-visible', 'command', 'visible-2', 'audit-read-site-visible-page-3',
              'not_observed', 'observed'),
            ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'message.deleted', 'v1', 'message',
              '2026-08-07 13:00:00.123456+00'::timestamptz, ${source}, 'recorded',
              'audit-read-site-visible', 'message', 'hidden-1', 'audit-read-site-visible-page-2',
              'not_observed', 'observed'),
            ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'command.executed', 'v1', 'command',
              '2026-08-07 13:00:00.123456+00'::timestamptz, ${source}, 'recorded',
              'audit-read-site-visible', 'command', 'visible-1', 'audit-read-site-visible-page-1',
              'not_observed', 'observed')
        `);

        const first = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events?source=${source}&limit=2`),
          readPrincipal,
          { db: tx as never },
        );
        const firstBody = first?.body as { readonly items: readonly { readonly id: string }[]; readonly nextCursor?: string };
        expect(firstBody.items.map((event) => event.id)).toEqual([
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
          'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        ]);
        expect(firstBody.nextCursor).toBeDefined();

        const second = await handleAuditReadRequest(
          'GET',
          apiUrl(`/api/v1/audit/events?source=${source}&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
          readPrincipal,
          { db: tx as never },
        );
        const secondBody = second?.body as { readonly items: readonly { readonly id: string }[]; readonly nextCursor?: string };
        expect(secondBody.items.map((event) => event.id)).toEqual([
          'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        ]);
        expect(secondBody.nextCursor).toBeUndefined();

        throw rollback;
      });
    } catch (error: unknown) {
      if (error !== rollback) throw error;
    }
  });
});

function apiUrl(path: string): URL {
  return new URL(path, 'http://backend-api.local');
}

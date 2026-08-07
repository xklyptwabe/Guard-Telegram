import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import {
  AuditEventsCursorError,
  encodeAuditEventsCursor,
  listAuditEvents,
} from '../../src/lib/audit/eventReadRepository.js';
import { PLATFORM_TENANT_SENTINEL } from '../../src/lib/audit/serviceAdapter.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
let database: DatabaseClient | undefined;

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
});

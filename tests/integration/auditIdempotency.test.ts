import { and, eq, inArray } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { entitySnapshots, events } from '../../src/db/schema/audit.js';
import { AuditIdempotencyConflictError, AuditService } from '../../src/lib/auditService.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const idempotencyKey = 'audit-idempotency-cross-tenant-test';
const tenants = ['audit-idempotency-tenant-a', 'audit-idempotency-tenant-b'] as const;
let database: DatabaseClient | undefined;
let audit: AuditService | undefined;

describe.skipIf(!testDatabaseUrl)('Audit idempotency integration', () => {
  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: 'src/db/migrations' });
    audit = new AuditService(database.db);
  });

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await database?.close();
  });

  it('does not return an existing event when the same key belongs to another tenant', async () => {
    const first = await audit!.recordEntityChange(inputFor(tenants[0]), async () => mutationFor(tenants[0]));
    let secondMutationCalled = false;

    const collision = audit!.recordEntityChange(inputFor(tenants[1]), async () => {
      secondMutationCalled = true;
      return mutationFor(tenants[1]);
    });

    await expect(collision).rejects.toThrow(AuditIdempotencyConflictError);
    await expect(collision).rejects.not.toThrow(first.eventId);
    expect(secondMutationCalled).toBe(false);

    const rows = await database!.db
      .select({ id: events.id, tenantId: events.tenantId })
      .from(events)
      .where(eq(events.idempotencyKey, idempotencyKey));
    expect(rows).toEqual([{ id: first.eventId, tenantId: tenants[0] }]);
  });

  it('keeps a matching retry idempotent', async () => {
    const input = inputFor(tenants[0]);
    const first = await audit!.recordEntityChange(input, async () => mutationFor(tenants[0]));
    const second = await audit!.recordEntityChange(input, async () => {
      throw new Error('mutation must not run for a matching retry');
    });

    expect(second).toEqual({
      eventId: first.eventId,
      subjectSequence: first.subjectSequence,
      duplicate: true,
    });

    const rows = await database!.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.idempotencyKey, idempotencyKey));
    expect(rows).toEqual([{ id: first.eventId }]);
  });
});

function inputFor(tenantId: string) {
  return {
    tenantId,
    subjectType: 'chat_module_state',
    subjectId: `${tenantId}:module-admin`,
    eventType: 'module.state.changed',
    eventVersion: 'v1',
    category: 'module',
    source: 'audit-idempotency-test',
    idempotencyKey,
  } as const;
}

function mutationFor(tenantId: string) {
  return {
    before: undefined,
    after: { enabled: true, source: 'override' },
    snapshotData: { chatId: tenantId, moduleId: 'module-admin', enabled: true, source: 'override' },
  };
}

async function cleanup(): Promise<void> {
  if (database === undefined) return;
  await database.db.delete(events).where(eq(events.idempotencyKey, idempotencyKey));
  await database.db
    .delete(entitySnapshots)
    .where(
      and(
        inArray(entitySnapshots.tenantId, tenants),
        eq(entitySnapshots.entityType, 'chat_module_state'),
      ),
    );
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { chatModuleStates, telegramChats } from '../../src/db/schema/core.js';
import { AuditService } from '../../src/lib/auditService.js';
import { events, entitySnapshots, eventPolicies, outbox } from '../../src/db/schema/audit.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
let database: DatabaseClient | undefined;
let audit: AuditService | undefined;

describe.skipIf(!testDatabaseUrl)('Audit transaction integration', () => {
  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: 'true',
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: 'src/db/migrations' });
    audit = new AuditService(database.db);
  });

  beforeEach(async () => {
    await database!.db.delete(telegramChats);
    await database!.db.delete(chatModuleStates);
    await database!.db.delete(outbox);
    await database!.db.delete(events);
    await database!.db.delete(entitySnapshots);
  });

  afterAll(async () => {
    await database?.close();
  });

  it('commits the business row and one audit event together', async () => {
    const first = await audit!.recordEntityChange(
      {
        tenantId: '1001',
        subjectType: 'chat_module_state',
        subjectId: '1001:module-admin',
        eventType: 'module.state.changed',
        eventVersion: 'v1',
        category: 'module',
        source: 'telegram.command',
        idempotencyKey: 'audit:test:1001:module-admin:true',
      },
      async (tx) => {
        await tx.insert(telegramChats).values({ chatId: '1001', type: 'group', title: 'audit-test' });
        await tx
          .insert(chatModuleStates)
          .values({ chatId: '1001', moduleId: 'module-admin', enabled: true });
        return {
          before: undefined,
          after: { enabled: true },
          changes: { enabled: { after: true } },
          snapshotData: { chatId: '1001', moduleId: 'module-admin', enabled: true },
        };
      },
    );

    expect(first.duplicate).toBe(false);

    const stateRows = await database!.db.select().from(chatModuleStates);
    const eventRows = await database!.db.select().from(events);
    const snapshotRows = await database!.db.select().from(entitySnapshots);
    const outboxRows = await database!.db.select().from(outbox);

    expect(stateRows).toHaveLength(1);
    expect(eventRows).toHaveLength(1);
    expect(snapshotRows).toHaveLength(1);
    expect(outboxRows).toHaveLength(1);
  });

  it('does not create a duplicate event for the same idempotency key', async () => {
    const input = {
      tenantId: '1002',
      subjectType: 'chat_module_state',
      subjectId: '1002:module-admin',
      eventType: 'module.state.changed',
      eventVersion: 'v1',
      category: 'module',
      source: 'telegram.command',
      idempotencyKey: 'audit:test:1002:module-admin:true',
    } as const;

    const first = await audit!.recordEntityChange(input, async (tx) => {
      await tx.insert(telegramChats).values({ chatId: '1002', type: 'group', title: 'audit-test' });
      await tx.insert(chatModuleStates).values({ chatId: '1002', moduleId: 'module-admin', enabled: true });
      return {
        before: undefined,
        after: { enabled: true },
        snapshotData: { chatId: '1002', moduleId: 'module-admin', enabled: true },
      };
    });

    const second = await audit!.recordEntityChange(input, async () => {
      throw new Error('must not run for duplicate idempotency key');
    });

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const eventRows = await database!.db.select().from(events);
    expect(eventRows).toHaveLength(1);
  });

  it('rolls back the business change and audit rows when the transaction fails', async () => {
    const input = {
      tenantId: '1003',
      subjectType: 'chat_module_state',
      subjectId: '1003:module-admin',
      eventType: 'module.state.changed',
      eventVersion: 'v1',
      category: 'module',
      source: 'telegram.command',
      idempotencyKey: 'audit:test:1003:module-admin:true',
    } as const;

    await expect(
      audit!.recordEntityChange(input, async (tx) => {
        await tx.insert(telegramChats).values({ chatId: '1003', type: 'group', title: 'audit-test' });
        await tx.insert(chatModuleStates).values({ chatId: '1003', moduleId: 'module-admin', enabled: true });
        throw new Error('forced failure');
      }),
    ).rejects.toThrow('forced failure');

    const stateRows = await database!.db.select().from(chatModuleStates);
    const eventRows = await database!.db.select().from(events);
    const snapshotRows = await database!.db.select().from(entitySnapshots);
    const outboxRows = await database!.db.select().from(outbox);

    expect(stateRows).toHaveLength(0);
    expect(eventRows).toHaveLength(0);
    expect(snapshotRows).toHaveLength(0);
    expect(outboxRows).toHaveLength(0);
  });

  it('fails closed when the audit policy is disabled', async () => {
    const input = {
      tenantId: '1004',
      subjectType: 'chat_module_state',
      subjectId: '1004:module-admin',
      eventType: 'module.state.changed',
      eventVersion: 'v1',
      category: 'module',
      source: 'telegram.command',
      idempotencyKey: 'audit:test:1004:module-admin:true',
    } as const;

    await database!.db.update(eventPolicies).set({ enabled: false }).where(and(eq(eventPolicies.eventType, 'module.state.changed'), eq(eventPolicies.eventVersion, 'v1')));

    try {
      await expect(
        audit!.recordEntityChange(input, async (tx) => {
          await tx.insert(telegramChats).values({ chatId: '1004', type: 'group', title: 'audit-test' });
          await tx.insert(chatModuleStates).values({ chatId: '1004', moduleId: 'module-admin', enabled: true });
          return {
            before: undefined,
            after: { enabled: true },
            snapshotData: { chatId: '1004', moduleId: 'module-admin', enabled: true },
          };
        }),
      ).rejects.toThrow('Audit policy is unavailable for module.state.changed@v1');

      const stateRows = await database!.db.select().from(chatModuleStates);
      const eventRows = await database!.db.select().from(events);
      const snapshotRows = await database!.db.select().from(entitySnapshots);
      const outboxRows = await database!.db.select().from(outbox);

      expect(stateRows).toHaveLength(0);
      expect(eventRows).toHaveLength(0);
      expect(snapshotRows).toHaveLength(0);
      expect(outboxRows).toHaveLength(0);
    } finally {
      await database!.db.update(eventPolicies).set({ enabled: true }).where(and(eq(eventPolicies.eventType, 'module.state.changed'), eq(eventPolicies.eventVersion, 'v1')));
    }
  });
});
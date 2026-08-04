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
          after: { enabled: true, source: 'override' },
          changes: { enabled: { after: true } },
          snapshotData: { chatId: '1001', moduleId: 'module-admin', enabled: true, source: 'override' },
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
    expect(eventRows[0]?.beforeSnapshotStatus).toBe('not_observed');
    expect(eventRows[0]?.afterSnapshotStatus).toBe('observed');
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
        after: { enabled: true, source: 'override' },
        snapshotData: { chatId: '1002', moduleId: 'module-admin', enabled: true, source: 'override' },
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
      subjectType: 'chat_settings',
      subjectId: '1004',
      eventType: 'chat.settings.changed',
      eventVersion: 'v1',
      category: 'chat',
      source: 'telegram.command',
      idempotencyKey: 'audit:test:1004:chat-settings',
    } as const;

    await database!.db.update(eventPolicies).set({ enabled: false }).where(and(eq(eventPolicies.eventType, 'chat.settings.changed'), eq(eventPolicies.eventVersion, 'v1')));

    try {
      await expect(
        audit!.recordEntityChange(input, async (tx) => {
          await tx.insert(telegramChats).values({ chatId: '1004', type: 'group', title: 'audit-test' });
          return {
            before: { chatId: '1004', locale: 'en' },
            after: { chatId: '1004', locale: 'ru' },
            changes: { locale: { before: 'en', after: 'ru' } },
            snapshotData: { chatId: '1004', locale: 'ru' },
          };
        }),
      ).rejects.toThrow('Audit policy is unavailable for chat.settings.changed@v1');

      const stateRows = await database!.db.select().from(chatModuleStates);
      const eventRows = await database!.db.select().from(events);
      const snapshotRows = await database!.db.select().from(entitySnapshots);
      const outboxRows = await database!.db.select().from(outbox);

      expect(stateRows).toHaveLength(0);
      expect(eventRows).toHaveLength(0);
      expect(snapshotRows).toHaveLength(0);
      expect(outboxRows).toHaveLength(0);
    } finally {
      await database!.db.update(eventPolicies).set({ enabled: true }).where(and(eq(eventPolicies.eventType, 'chat.settings.changed'), eq(eventPolicies.eventVersion, 'v1')));
    }
  });

  it('persists the entity snapshot status returned by the audit mutation', async () => {
    const first = await audit!.recordEntityChange(
      {
        tenantId: '1005',
        subjectType: 'chat_settings',
        subjectId: '1005',
        eventType: 'chat.settings.changed',
        eventVersion: 'v1',
        category: 'chat',
        source: 'telegram.command',
        idempotencyKey: 'audit:test:1005:chat-settings:delete',
      },
      async (tx) => {
        await tx.insert(telegramChats).values({ chatId: '1005', type: 'group', title: 'audit-test' });
        return {
          before: { chatId: '1005', locale: 'ru' },
          after: undefined,
          afterSnapshotStatus: 'not_applicable',
          changes: { status: 'computed', fields: { locale: { before: 'ru', after: undefined } } },
          snapshotStatus: 'archived',
          snapshotData: { chatId: '1005', locale: 'ru' },
        };
      },
    );

    expect(first.duplicate).toBe(false);

    const snapshotRows = await database!.db.select().from(entitySnapshots);
    expect(snapshotRows).toHaveLength(1);
    expect(snapshotRows[0]?.snapshotStatus).toBe('archived');
  });

  it('merges mutation metadata into the persisted event and outbox payload', async () => {
    await audit!.recordEntityChange(
      {
        tenantId: '1006',
        subjectType: 'chat_module_state',
        subjectId: '1006:module-admin',
        eventType: 'module.state.changed',
        eventVersion: 'v1',
        category: 'module',
        source: 'telegram.command',
        idempotencyKey: 'audit:test:1006:module-admin:metadata',
        metadata: { source: 'test' },
      },
      async (tx) => {
        await tx.insert(telegramChats).values({ chatId: '1006', type: 'group', title: 'audit-test' });
        await tx.insert(chatModuleStates).values({ chatId: '1006', moduleId: 'module-admin', enabled: true });
        return {
          before: undefined,
          after: { enabled: true, source: 'override' },
          metadata: { operation: 'update' },
          snapshotData: { chatId: '1006', moduleId: 'module-admin', enabled: true, source: 'override' },
        };
      },
    );

    const eventRows = await database!.db.select().from(events);
    const outboxRows = await database!.db.select().from(outbox);

    expect(eventRows[0]?.metadata).toEqual({ source: 'test', operation: 'update' });
    expect((outboxRows[0]?.payload as { metadata?: unknown } | undefined)?.metadata).toEqual({
      source: 'test',
      operation: 'update',
    });
  });
});

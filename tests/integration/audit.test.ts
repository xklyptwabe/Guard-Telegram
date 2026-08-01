import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { chatModuleStates } from '../../src/db/schema/core.js';
import { AuditService } from '../../src/lib/auditService.js';
import { events, entitySnapshots } from '../../src/db/schema/audit.js';

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
    await database!.db.delete(chatModuleStates);
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

    expect(stateRows).toHaveLength(1);
    expect(eventRows).toHaveLength(1);
    expect(snapshotRows).toHaveLength(1);
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
});
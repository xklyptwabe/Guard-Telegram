import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { pendingOperations } from '../../src/db/schema/moderation.js';
import type { Logger } from '../../src/lib/logger.js';
import {
  PendingOperationResolvers,
  PendingOperationsOutbox,
} from '../../src/lib/moderation/pendingOperationsOutbox.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const ownerId = `bots12-recovery-drill-${randomUUID()}`;

describe.skipIf(!testDatabaseUrl)('audit outbox recovery drill', () => {
  let database: DatabaseClient;

  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'bots12-recovery-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    database = createDatabase(config);
    await migrate(database.db, { migrationsFolder: 'src/db/migrations' });
  });

  afterAll(async () => {
    if (database === undefined) return;
    await database.db.delete(pendingOperations).where(eq(pendingOperations.ownerId, ownerId));
    await database.close();
  });

  it('backfills audit debt after restart without repeating the completed operation', async () => {
    const kind = 'bots12.recovery-drill';
    const idempotencyKey = `${ownerId}:operation`;
    const executor = vi.fn(async () => ({ accepted: true }));
    const resolvers = new PendingOperationResolvers();
    resolvers.register(kind, executor);
    const beforeRestart = new PendingOperationsOutbox(
      database.db,
      silentLogger(),
      resolvers,
      3,
      1_000,
      1_000,
      ownerId,
    );

    await beforeRestart.execute(
      {
        kind,
        chatId: '__bots12_recovery_drill__',
        idempotencyKey,
        requestPayload: {},
        auditEvent: { eventType: 'integration.action', eventVersion: 'v1' },
        recoveryMetadata: {
          action: 'recovery_drill',
          integrationId: 'bots12',
          targetType: 'test_fixture',
          targetId: 'synthetic',
        },
      },
      executor,
      async () => Promise.reject(new Error('synthetic audit outage')),
    );

    const [owedAudit] = await database.db
      .select()
      .from(pendingOperations)
      .where(eq(pendingOperations.idempotencyKey, idempotencyKey));
    expect(owedAudit).toMatchObject({ status: 'succeeded', auditStatus: 'pending' });
    expect(executor).toHaveBeenCalledOnce();

    const finalizer = vi.fn(async () => ({ status: 'recorded' as const }));
    const afterRestart = new PendingOperationsOutbox(
      database.db,
      silentLogger(),
      resolvers,
      3,
      1_000,
      1_000,
      ownerId,
    );
    await afterRestart.recoverPending(finalizer);
    await afterRestart.recoverPending(finalizer);

    const [recovered] = await database.db
      .select()
      .from(pendingOperations)
      .where(eq(pendingOperations.idempotencyKey, idempotencyKey));
    expect(recovered).toMatchObject({
      status: 'succeeded',
      auditStatus: 'written',
      requestPayload: {},
      metadata: {},
      result: null,
    });
    expect(executor).toHaveBeenCalledOnce();
    expect(finalizer).toHaveBeenCalledOnce();
  });
});

function silentLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

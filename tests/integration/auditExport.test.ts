import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { eventPolicies, events } from '../../src/db/schema/audit.js';
import { createAuditExport } from '../../src/lib/audit/exportService.js';
import type { AuditService } from '../../src/lib/auditService.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const tenantId = 'audit-export-effective-policy-test';
const eventId = 'f1111111-1111-4111-8111-111111111111';
const policyId = 'integration:audit-export-effective-policy';
const source = 'audit-export-effective-policy-test';
let database: DatabaseClient | undefined;

describe.skipIf(!testDatabaseUrl)('Audit export effective policy integration', () => {
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

  it('reapplies the current allowlist and masking to historical JSON and CSV rows from PostgreSQL', async () => {
    const rollback = new Error('rollback audit export effective policy test');
    let jsonData: unknown;
    let csvData: unknown;

    try {
      await database!.db.transaction(async (tx) => {
        await tx.delete(events).where(eq(events.id, eventId));
        await tx.delete(eventPolicies).where(eq(eventPolicies.policyId, policyId));
        await tx.insert(eventPolicies).values({
          policyId,
          chatId: tenantId,
          eventType: 'message.deleted',
          eventVersion: 'v1',
          enabled: true,
          exportAllowed: true,
          allowlist: ['chatId', 'messageId', 'deletedBy'],
          masking: ['deletedBy', 'policySensitive'],
        });
        await tx.insert(events).values({
          id: eventId,
          eventType: 'message.deleted',
          eventVersion: 'v1',
          category: 'message',
          occurredAt: new Date('2026-08-07T10:00:00.000Z'),
          source,
          tenantId,
          subjectType: 'message',
          subjectId: `${tenantId}:message-1`,
          idempotencyKey: 'integration:audit-export-effective-policy:event',
          beforeSnapshotStatus: 'observed',
          afterSnapshotStatus: 'observed',
          before: historicalSnapshot(),
          after: historicalSnapshot(),
          changes: {
            status: 'updated',
            fields: {
              userId: { before: 'historical-user', after: 'historical-user' },
              deletedBy: { before: 'historical-sensitive-value', after: 'historical-sensitive-value' },
              text: { before: 'historical message text', after: 'historical message text' },
            },
          },
          metadata: {
            moduleId: 'moderation',
            deletedBy: 'historical-sensitive-value',
            policySensitive: 'historical-policy-sensitive',
            innocentLabel: 'historical-innocent-label',
            secretToken: 'historical-secret-token',
          },
        });

        const input = {
          scope: { systemAdmin: false, allowedChatIds: [tenantId] },
          filters: { source },
          requestedBy: 'integration-operator',
        } as const;
        const audit = fakeAuditService();
        jsonData = (await createAuditExport(tx, audit, { ...input, format: 'json' })).data;
        csvData = (await createAuditExport(tx, audit, { ...input, format: 'csv' })).data;

        throw rollback;
      });
    } catch (error: unknown) {
      if (error !== rollback) throw error;
    }

    const json = JSON.stringify(jsonData);
    expect(json).toContain('[redacted]');
    expect(json).not.toContain('historical-sensitive-value');
    expect(json).not.toContain('historical message text');
    expect(json).not.toContain('historical-secret-token');
    expect(json).not.toContain('historical-policy-sensitive');
    expect(json).not.toContain('innocentLabel');
    expect(json).not.toContain('historical-innocent-label');
    expect(json).not.toContain('policySensitive');

    expect(csvData).toEqual(expect.any(String));
    const csv = String(csvData);
    expect(csv).toContain('[redacted]');
    expect(csv).not.toContain('historical-sensitive-value');
    expect(csv).not.toContain('historical message text');
    expect(csv).not.toContain('historical-secret-token');
    expect(csv).not.toContain('historical-policy-sensitive');
    expect(csv).not.toContain('innocentLabel');
    expect(csv).not.toContain('historical-innocent-label');
    expect(csv).not.toContain('policySensitive');
  });
});

function historicalSnapshot(): Record<string, unknown> {
  return {
    chatId: tenantId,
    messageId: 'message-1',
    userId: 'historical-user',
    deletedBy: 'historical-sensitive-value',
    text: 'historical message text',
  };
}

function fakeAuditService(): AuditService {
  return {
    recordEntityChange: async (_input: unknown, mutate: () => Promise<unknown>) => {
      await mutate();
      return { eventId: 'f2222222-2222-4222-8222-222222222222', subjectSequence: 1, duplicate: false };
    },
  } as unknown as AuditService;
}

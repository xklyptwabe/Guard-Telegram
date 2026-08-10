import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleAuditReadRequest } from '../../src/api/auditRead.js';
import type { BackendApiPrincipal } from '../../src/api/access.js';
import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const chatId = 'audit-policy-resolution-chat';
const moduleId = 'moderation';
let database: DatabaseClient | undefined;

const readPrincipal: BackendApiPrincipal = {
  actorId: 'audit-policy-reader',
  permissions: ['audit.events.read'],
  allowedChatIds: [chatId],
  systemAdmin: false,
};

describe.skipIf(!testDatabaseUrl)('Audit policy read integration', () => {
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

  it('returns raw policies and effective values with sources for all six priority levels', async () => {
    const rollback = new Error('rollback audit policy read integration');

    try {
      await database!.db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE audit.event_policies
          SET site_visible = true
          WHERE policy_id = 'global:event:message.deleted:v1'
        `);
        await tx.execute(sql`
          INSERT INTO audit.event_policies (
            policy_id, chat_id, event_type, event_version, module_id,
            enabled, site_visible, snapshot_mode, allowlist, masking,
            retention_days, severity, export_allowed
          ) VALUES
            ('integration:policy-resolution:global', NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, false),
            ('integration:policy-resolution:global-module', NULL, NULL, NULL, ${moduleId},
              NULL, NULL, NULL, NULL, NULL, NULL, 'warning', NULL),
            ('integration:policy-resolution:chat', ${chatId}, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, NULL, 30, NULL, NULL),
            ('integration:policy-resolution:chat-module', ${chatId}, NULL, NULL, ${moduleId},
              NULL, NULL, 'metadata', NULL, NULL, NULL, NULL, NULL),
            ('integration:policy-resolution:chat-event', ${chatId}, 'message.deleted', 'v1', NULL,
              true, NULL, NULL, '["chatId", "messageId"]'::jsonb, '["deletedBy"]'::jsonb,
              NULL, NULL, NULL)
        `);

        const response = await handleAuditReadRequest(
          'GET',
          policyUrl({ chatId, eventType: 'message.deleted', eventVersion: 'v1', moduleId }),
          readPrincipal,
          { db: tx as never },
        );
        expect(response?.statusCode).toBe(200);

        const body = response?.body as {
          readonly items: readonly Record<string, unknown>[];
          readonly effectivePolicy?: {
            readonly target: Record<string, unknown>;
            readonly values: Record<string, unknown>;
            readonly sources: Record<string, unknown>;
          };
        };
        expect(body.items).toHaveLength(3);
        expect(body.items).toEqual(expect.arrayContaining([
          expect.objectContaining({
            policyId: 'integration:policy-resolution:chat-event',
            enabled: true,
            allowlist: ['chatId', 'messageId'],
            masking: ['deletedBy'],
          }),
          expect.objectContaining({
            policyId: 'integration:policy-resolution:chat-module',
            snapshotMode: 'metadata',
          }),
          expect.objectContaining({
            policyId: 'integration:policy-resolution:chat',
            retentionDays: 30,
          }),
        ]));
        expect(body.effectivePolicy?.target).toEqual({
          chatId,
          eventType: 'message.deleted',
          eventVersion: 'v1',
          moduleId,
        });
        expect(body.effectivePolicy?.values).toMatchObject({
          enabled: true,
          siteVisible: true,
          snapshotMode: 'metadata',
          allowlist: ['chatId', 'messageId'],
          masking: ['deletedBy'],
          retentionDays: 30,
          severity: 'warning',
          exportAllowed: false,
        });
        expect(body.effectivePolicy?.sources).toMatchObject({
          enabled: sourceFrom('integration:policy-resolution:chat-event', 'chat_event_type', true),
          snapshotMode: sourceFrom('integration:policy-resolution:chat-module', 'chat_module', 'metadata'),
          retentionDays: sourceFrom('integration:policy-resolution:chat', 'chat', 30),
          siteVisible: sourceFrom('global:event:message.deleted:v1', 'global_event_type', true),
          severity: sourceFrom('integration:policy-resolution:global-module', 'global_module', 'warning'),
          exportAllowed: sourceFrom('integration:policy-resolution:global', 'global', false),
        });

        await tx.execute(sql`
          UPDATE audit.event_policies
          SET enabled = false
          WHERE policy_id = 'integration:policy-resolution:chat-event'
        `);
        const changed = await handleAuditReadRequest(
          'GET',
          policyUrl({ chatId, eventType: 'message.deleted', eventVersion: 'v1', moduleId }),
          readPrincipal,
          { db: tx as never },
        );
        expect(changed?.body).toMatchObject({
          effectivePolicy: {
            values: { enabled: false },
            sources: {
              enabled: sourceFrom('integration:policy-resolution:chat-event', 'chat_event_type', false),
            },
          },
        });

        const forbidden = await handleAuditReadRequest(
          'GET',
          policyUrl({ chatId: 'another-chat', eventType: 'message.deleted', eventVersion: 'v1', moduleId }),
          readPrincipal,
          { db: tx as never },
        );
        expect(forbidden).toEqual({
          statusCode: 403,
          body: { error: { code: 'forbidden', message: 'Forbidden' } },
        });

        const legacy = await handleAuditReadRequest(
          'GET',
          new URL('/api/v1/audit/policies', 'http://backend-api.local'),
          readPrincipal,
          { db: tx as never },
        );
        expect(legacy?.body).not.toHaveProperty('effectivePolicy');

        throw rollback;
      });
    } catch (error: unknown) {
      if (error !== rollback) throw error;
    }
  });
});

function policyUrl(target: {
  readonly chatId: string;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly moduleId: string;
}): URL {
  const search = new URLSearchParams(target);
  return new URL(`/api/v1/audit/policies?${search}`, 'http://backend-api.local');
}

function sourceFrom(policyId: string, priority: string, value: unknown): Record<string, unknown> {
  return { value, source: 'policy', policyId, priority };
}

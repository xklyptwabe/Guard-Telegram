import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('telegram_bot role privileges (0019/0020/0023/0030)', () => {
  let client: DatabaseClient;

  beforeAll(() => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'role-test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    client = createDatabase(config);
  });

  afterAll(async () => {
    await client.close();
  });

  it('creates telegram_bot and forbids UPDATE/DELETE on audit.events', async () => {
    const roles = await client.db.execute(sql`SELECT 1 AS ok FROM pg_roles WHERE rolname = 'telegram_bot'`);
    expect(roles.rowCount ?? (roles as { rows?: unknown[] }).rows?.length).toBeGreaterThan(0);

    const update = await client.db.execute(sql`SELECT has_table_privilege('telegram_bot', 'audit.events', 'UPDATE') AS allowed`);
    const del = await client.db.execute(sql`SELECT has_table_privilege('telegram_bot', 'audit.events', 'DELETE') AS allowed`);
    const insert = await client.db.execute(sql`SELECT has_table_privilege('telegram_bot', 'audit.events', 'INSERT') AS allowed`);

    const flag = (result: { rows?: Array<{ allowed?: boolean }> }) => result.rows?.[0]?.allowed;
    expect(flag(update as never)).toBe(false);
    expect(flag(del as never)).toBe(false);
    expect(flag(insert as never)).toBe(true);
  });

  it('grants state-machine updates without mutable inbox/outbox identity or payload', async () => {
    const privileges = await client.db.execute(sql`
      SELECT
        has_table_privilege('telegram_bot', 'moderation.pending_operations', 'UPDATE') AS "pendingTableUpdate",
        has_column_privilege('telegram_bot', 'moderation.pending_operations', 'status', 'UPDATE') AS "pendingStatusUpdate",
        has_column_privilege('telegram_bot', 'moderation.pending_operations', 'kind', 'UPDATE') AS "pendingKindUpdate",
        has_column_privilege('telegram_bot', 'moderation.pending_operations', 'chat_id', 'UPDATE') AS "pendingChatUpdate",
        has_column_privilege('telegram_bot', 'moderation.pending_operations', 'request_payload', 'UPDATE') AS "pendingRequestUpdate",
        has_column_privilege('telegram_bot', 'moderation.pending_operations', 'metadata', 'UPDATE') AS "pendingMetadataUpdate",
        has_column_privilege('telegram_bot', 'moderation.pending_operations', 'idempotency_key', 'UPDATE') AS "pendingKeyUpdate",
        has_table_privilege('telegram_bot', 'core.processed_updates', 'UPDATE') AS "inboxTableUpdate",
        has_column_privilege('telegram_bot', 'core.processed_updates', 'status', 'UPDATE') AS "inboxStatusUpdate",
        has_column_privilege('telegram_bot', 'core.processed_updates', 'bot_id', 'UPDATE') AS "inboxBotUpdate",
        has_column_privilege('telegram_bot', 'core.processed_updates', 'update_id', 'UPDATE') AS "inboxUpdateIdUpdate",
        has_table_privilege('telegram_bot', 'core.consumed_envelopes', 'UPDATE') AS "envelopeTableUpdate",
        has_column_privilege('telegram_bot', 'core.consumed_envelopes', 'status', 'UPDATE') AS "envelopeStatusUpdate",
        has_column_privilege('telegram_bot', 'core.consumed_envelopes', 'envelope_id', 'UPDATE') AS "envelopeIdUpdate"
    `);
    const row = (privileges as { rows?: Array<Record<string, boolean>> }).rows?.[0];

    expect(row).toMatchObject({
      pendingTableUpdate: false,
      pendingStatusUpdate: true,
      pendingKindUpdate: false,
      pendingChatUpdate: false,
      pendingRequestUpdate: false,
      pendingMetadataUpdate: false,
      pendingKeyUpdate: false,
      inboxTableUpdate: false,
      inboxStatusUpdate: true,
      inboxBotUpdate: false,
      inboxUpdateIdUpdate: false,
      envelopeTableUpdate: false,
      envelopeStatusUpdate: true,
      envelopeIdUpdate: false,
    });
  });

  it('hides internal public Telegram entities from Data API roles while preserving narrow bot access', async () => {
    const result = await client.db.execute(sql`
      SELECT
        (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.telegram_chats'::regclass) AS "chatsRls",
        (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.telegram_users'::regclass) AS "usersRls",
        COALESCE(
          has_table_privilege(
            (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
            'public.telegram_chats',
            'SELECT'
          ),
          false
        ) AS "anonChatsSelect",
        COALESCE(
          has_table_privilege(
            (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'),
            'public.telegram_chats',
            'DELETE'
          ),
          false
        ) AS "authenticatedChatsDelete",
        COALESCE(
          has_table_privilege(
            (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
            'public.telegram_users',
            'INSERT'
          ),
          false
        ) AS "anonUsersInsert",
        COALESCE(
          has_table_privilege(
            (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'),
            'public.telegram_users',
            'UPDATE'
          ),
          false
        ) AS "authenticatedUsersUpdate",
        has_table_privilege('telegram_bot', 'public.telegram_chats', 'SELECT,INSERT,UPDATE') AS "botChatsWrite",
        has_table_privilege('telegram_bot', 'public.telegram_chats', 'DELETE') AS "botChatsDelete",
        has_table_privilege('telegram_bot', 'public.telegram_users', 'SELECT,INSERT,UPDATE') AS "botUsersWrite",
        has_table_privilege('telegram_bot', 'public.telegram_users', 'DELETE') AS "botUsersDelete"
    `);
    const row = (result as { rows?: Array<Record<string, boolean>> }).rows?.[0];

    expect(row).toMatchObject({
      chatsRls: true,
      usersRls: true,
      anonChatsSelect: false,
      authenticatedChatsDelete: false,
      anonUsersInsert: false,
      authenticatedUsersUpdate: false,
      botChatsWrite: true,
      botChatsDelete: false,
      botUsersWrite: true,
      botUsersDelete: false,
    });
  });
});

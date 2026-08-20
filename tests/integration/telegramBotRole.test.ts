import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('telegram_bot role privileges (0019)', () => {
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
});

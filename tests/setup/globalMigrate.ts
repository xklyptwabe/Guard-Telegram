/**
 * Makes `npm test` self-sufficient on a clean Postgres: integration files
 * assume `audit.*` already exist. CI still runs `db:migrate` first — this
 * is idempotent. Unit files do not need a database; we no-op without URL.
 */
export default async function globalMigrate(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) return;

  process.env.DATABASE_URL = databaseUrl;
  process.env.TELEGRAM_BOT_TOKEN ??= 'vitest-global-migrate-token';
  process.env.DATABASE_TLS_REJECT_UNAUTHORIZED ??= process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'false';

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations();
}

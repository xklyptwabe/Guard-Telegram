# Database layer and migrations

`src/db/client.ts` creates one `pg.Pool` and one Drizzle client with TLS options. PostgreSQL is authoritative; Redis never becomes the owner of configuration or module state.

Public schema tables anchor Telegram chats and users. Schema `core` holds chat settings, sparse module overrides, idempotency records, and release-announcement metadata. External Telegram IDs are text. Foreign keys cascade from `telegram_chats`, and `processed_updates` has an indexed seven-day retention cleanup.

Create migrations only with `npm run db:generate`, inspect them, and apply with `npm run db:migrate`. Make changes additive: nullable/default, backfill, then later removal. The integration suite is enabled only with `TEST_DATABASE_URL` pointing to a dedicated TLS test database.

# Guard Telegram Bot

Server-side Telegram bot for private chats, groups, supergroups, and forum topics. It is a TypeScript/ESM, strict-mode foundation for independently deployable bot modules. Settings and module state are isolated by `chat_id`; PostgreSQL is the source of truth.

The project deliberately has no audit log. It does not persist message bodies, edited-message data, reactions, raw update JSON, files, or callback payloads. `core.processed_updates` contains only `(bot_id, update_id, timestamps)` for idempotency and is retained for seven days by default.

## What is included

- grammY, one `Bot` instance, native commands, inline callbacks, and forum-topic-aware replies;
- global and local modules with sparse per-chat state overrides;
- PostgreSQL + Drizzle migrations, TLS database connections, and typed external IDs;
- RU/EN localization, JSON logs with redaction, permissions, cooldowns, callback validation, and duplicate-update protection;
- long polling through `@grammyjs/runner` or an HTTPS webhook adapter;
- optional Redis, S3/MinIO, and AMQPS RabbitMQ with durable publishes, retry queue, and DLQ;
- Vitest, ESLint, TypeScript strict checks, Docker, GitLab CI, ADRs, and operational runbooks.

## Prerequisites

- Node.js 22 or later;
- a PostgreSQL instance reachable over TLS;
- a Telegram Bot API token from the deployment secret store;
- optional TLS endpoints for Redis, S3/MinIO, and RabbitMQ.

Never commit `.env`, tokens, database URLs, certificates, or webhook secrets.

## Local start

```bash
cp .env.example .env
# Fill TELEGRAM_BOT_TOKEN and a TLS-protected DATABASE_URL in .env
npm install
npm run db:migrate
npm run dev
```

`npm start` runs the compiled production output. The first migration must be generated through `npm run db:generate`; generated files in `src/db/migrations/` are not edited manually.

## Environment and TLS

`TELEGRAM_BOT_TOKEN` and `DATABASE_URL` are mandatory. PostgreSQL always receives an SSL configuration; `DATABASE_TLS_REJECT_UNAUTHORIZED` remains `true` outside tightly controlled development/test infrastructure. Client certificate and key must be supplied as a pair.

Setting `REDIS_ENABLED=true` requires `REDIS_TLS=true`. `S3_ENDPOINT`, `S3_PUBLIC_URL`, and `TELEGRAM_WEBHOOK_URL` must be HTTPS. `RABBITMQ_ENABLED=true` accepts only `amqps://`. Invalid combinations stop the process before it accepts Telegram updates.

See [.env.example](.env.example) for the complete list. Redis and S3 are optional: Redis failure degrades to database/in-memory paths, while a disabled storage feature returns a localized module-level response. RabbitMQ is different: a configured bridge must connect at startup or bootstrap fails.

## Commands, callbacks, and module state

The bootstrap includes:

| Command | Module | Default |
| --- | --- | --- |
| `/help` | `help` | enabled globally |
| `/modules` | `module-admin` | enabled globally, chat-admin only |
| `/module_enable <id>` | `module-admin` | chat-admin only |
| `/module_disable <id>` | `module-admin` | chat-admin only |
| `/echo <text>` | `example-tools` | disabled local-module example |

Telegram’s command menu is a union across modules and is registered in RU and EN. It is a hint, not an authorization system: the dispatcher always rechecks module state, permissions, cooldown, and a Zod schema. grammY handles `/command@bot_username` in groups. The only deep-link entry point is `/start <payload>`; a sensitive module must sign its payload or map it to a one-time database record.

Callback data has the compact `v1:<command>:<base64url-arguments>` format and is capped to Telegram’s 64-byte limit. No secrets or personal data belong in it. Every callback query is answered, including invalid or rejected ones.

`core.chat_module_states` is sparse. No row means the module’s `defaultEnabled`; an override is deleted when it becomes equal to that default. This avoids a chat-by-module backfill when a module is introduced.

## Transport and forum topics

`TELEGRAM_TRANSPORT=long_polling` is the default. It runs through `@grammyjs/runner`; `TELEGRAM_RUNNER_CONCURRENCY` bounds in-flight updates (default `25`). Set `TELEGRAM_TRANSPORT=webhook` only with an HTTPS `TELEGRAM_WEBHOOK_URL`, a 16+ character secret, and a public endpoint; in that mode polling is not started.

Replies use the incoming `message_thread_id` so they stay within a forum topic. If Telegram reports `TOPIC_CLOSED` or `message thread not found`, no message is sent to the parent chat unless both the command explicitly opts in and `TELEGRAM_TOPIC_FALLBACK_TO_CHAT=true`.

## Commands for development and CI

```text
npm run dev              # watch TypeScript source
npm run build            # emit dist/
npm start                # run dist/index.js
npm run lint             # ESLint source checks
npm run typecheck        # strict app and test type checks
npm test                 # unit tests; DB integration is opt-in
npm run test:coverage    # Vitest coverage report
npm run db:generate      # generate Drizzle migration
npm run db:migrate       # apply generated migrations
npm run db:studio        # Drizzle Studio
npm run check:locales    # ensure RU/EN keys agree
```

Set `TEST_DATABASE_URL` to a separate TLS PostgreSQL database to activate the migration integration suite. It must never point at production.

## Docker and deployment

`docker compose up --build` starts only the bot and reads local secrets from `.env`; PostgreSQL, Redis, S3/MinIO, and RabbitMQ are deliberately external protected services. The Dockerfile runs lint, typecheck, tests, and the build before the runtime image is produced.

GitLab CI follows `quality → build → deploy`. Stage and production deploy jobs are manual/protected and do not create, replace, or copy an environment file. Deployment and recovery steps are in [docs/infra/deploy.md](docs/infra/deploy.md) and [docs/infra/recovery-and-monitoring.md](docs/infra/recovery-and-monitoring.md).

## Security and operations

- Logs are one JSON object per line; redaction removes secrets and URL userinfo. Do not add message text, raw callbacks, headers, or file bytes to fields.
- Telegram IDs are stored as `text`, preserving every external ID exactly.
- Any state-changing module operation must rely on the `processed_updates` idempotency gate and Drizzle transactions/services rather than event-bus delivery.
- RabbitMQ uses a confirm channel and persistent messages. Failed actions retry through a TTL queue; exhausted or malformed items go to DLQ.
- Health reports transport and optional dependency state without messages or payloads. A degraded Redis/S3 path does not make the process unhealthy; an enabled RabbitMQ bridge without a connection does.

Detailed implementation contracts are in [docs/modules](docs/modules), design decisions in [docs/adr](docs/adr), and runbooks in [docs/infra](docs/infra).

# Bootstrap, transport, and shutdown

Bootstrap is ordered: dotenv → Zod configuration → i18n → PostgreSQL migrations → retention cleanup → optional Redis/S3 → enabled RabbitMQ → module validation → bot initialization → middleware/menu registration → transport. Any failure before transport stops the process without accepting updates.

`src/core/telegram.ts` owns the sole `new Bot(...)`. It installs `auto-retry` and `bot.catch`; modules never create a Telegram client. Long polling uses `@grammyjs/runner`. Webhook mode configures the HTTPS URL and secret token, validates a minimal update envelope, and binds only the configured path.

On `SIGINT` or `SIGTERM`, the transport stops first, then RabbitMQ, Redis, S3, and the database pool. A component failure is logged but does not prevent the remaining resources from being closed.

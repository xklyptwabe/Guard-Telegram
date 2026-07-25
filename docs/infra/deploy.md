# Deployment runbook

1. Build and validate the exact commit with `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
2. Generate migrations in development, review them, and apply them to a dedicated TLS test database before the target environment.
3. Provision secrets in the platform secret store. Do not copy, render, or modify an existing environment `.env` during deployment.
4. Confirm PostgreSQL TLS, optional Redis/S3 TLS, and AMQPS connectivity from the deployment network.
5. Deploy one bot instance per token/transport. Long polling must not coexist with a configured webhook for the same token.
6. Check JSON bootstrap, migration, menu, and transport events plus the health snapshot. Send a non-sensitive `/help` in a test chat.

Rollback application code independently from additive migrations. Never roll back by deleting production data; use a forward corrective migration when data shape has already changed.

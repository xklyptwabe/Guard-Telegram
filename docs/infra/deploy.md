# Deployment runbook

## Shared release rules

- Deploy only a reviewed commit with its commit SHA and evidence recorded for the target environment.
- Keep secrets in the platform secret store. Do not copy, render, commit, or modify an existing deployment `.env`.
- Treat migrations as forward-only. Generate and review new migrations in development, never edit an applied SQL migration, and prove the complete migration chain on a clean disposable PostgreSQL database before Test.
- Deploy application code and additive/backward-compatible migrations independently. A code rollback must not require deleting data or reversing migration history.
- One bot token has one active transport. Long polling and webhook delivery must not run concurrently for the same token.

## Before deploying to Test

1. Record the candidate commit SHA and confirm the working tree used to produce it is clean.
2. Run the CI-equivalent checks for that commit:

   ```bash
   npm ci
   npm run lint
   npm run typecheck
   npm run check:locales
   npm run build
   npm run test:coverage
   ```

3. With `TEST_DATABASE_URL` pointing only to a disposable test database, apply every migration from an empty schema and run the database integration/e2e suites. Compare the result with the Test environment's Drizzle history; do not rewrite unknown history entries.
4. Confirm Test secret-store values and network access for PostgreSQL TLS and enabled Redis, S3, RabbitMQ, webhook, backend API, and operational endpoints. Verify that `TELEGRAM_ALLOWED_UPDATES` includes every update type required by the release.
5. Confirm the GitLab merge-request quality jobs are green. A push to `test` automatically builds and deploys the image; it is not a manual deploy gate in this repository.
6. After deployment, require `database.migrations.completed` and `bootstrap.completed`, then check `GET /health`, `GET /metrics`, audit/outbox counts, and a non-sensitive `/help` in the designated Test chat. Record evidence rather than marking an unperformed check passed.

## Before deploying to production

1. Identify the exact production commit SHA and its approved Test evidence. If merge mechanics changed the SHA, document the reviewed relationship and rerun required checks for the production commit.
2. Require a green GitLab pipeline, completed Test migration/regression evidence, the Test smoke result, reviewed migration compatibility, and an agreed rollback owner/window.
3. Confirm production backups and restore procedures are current, but do not take an application rollback to mean a database restore. Check secret references and dependency health without printing secret values.
4. Review current `audit:diagnose`, `GET /health`, `GET /metrics`, and both audit alert states so a pre-existing backlog is not attributed to the new release.
5. Confirm the previously deployed image tag is still available. The repository retains only the two most recent `guard-telegram-bot` images on the deployment host.
6. A push to `main` automatically builds and deploys production. After it completes, run the separate production smoke procedure for the exact deployed SHA; Test evidence is not a substitute for that check.

## Post-deploy verification

Require all of the following before declaring the environment healthy:

- `database.migrations.completed` and `bootstrap.completed` for the new instance;
- HTTP 200 from `GET /health`, with PostgreSQL ready and audit not unhealthy;
- `GET /metrics` is scrapeable and `audit_outbox_pending` has no unexplained growth;
- no new `bootstrap.failed`, database connection, mandatory audit write, worker, or audit finalization errors;
- `AuditMandatoryWriteFailed` and `AuditOutboxBacklogGrowing` are inactive, or any pre-existing state is explicitly documented;
- the environment-specific non-sensitive Telegram smoke succeeds without exposing user data.

Use [the recovery and monitoring runbook](recovery-and-monitoring.md) for any failed criterion.

## Rollback and migration correction

Rollback criteria include an unhealthy bootstrap, a confirmed regression in required commands, sustained new audit/outbox failures, or an incompatible integration response. Stop rollout, preserve logs and aggregate evidence, and redeploy the previously approved application image when that code is compatible with the already-applied schema.

Do not run down migrations, delete production data, edit `drizzle.__drizzle_migrations`, or restore a whole database merely to revert application code. If the previous image is not schema-compatible, keep the environment contained and ship a reviewed forward corrective migration/application fix. After either rollback or forward fix, repeat the full post-deploy verification and record the resulting SHA and evidence.

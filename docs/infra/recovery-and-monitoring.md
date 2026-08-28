# Recovery and monitoring

Monitor bootstrap/migration failure, transport start/stop, duplicate-update skips, command failures, optional-service degradation, RabbitMQ retry/DLQ, database pool errors, and process restarts. Alerts must use metadata only; do not forward message bodies or callback data.

For Redis/S3 degradation, retain the service but investigate the TLS endpoint and credentials; PostgreSQL remains authoritative. For an enabled RabbitMQ outage, prevent new deployment rollout until AMQPS health is restored, then inspect retry and DLQ counts before replaying any action with an idempotent handler.

For a closed forum topic, the default is no parent-chat message. Enable fallback only for a command whose product contract explicitly permits it. Database recovery follows the PostgreSQL backup/restore runbook; after restore, use the seven-day idempotency window to avoid replaying business effects.

## Audit alerts

Prometheus must scrape the bot's loopback `GET /metrics` endpoint and load
[`monitoring/prometheus/audit-alerts.yml`](../../monitoring/prometheus/audit-alerts.yml)
through its `rule_files` configuration. Alertmanager routing and receivers remain deployment-specific.

- `AuditMandatoryWriteFailed` is critical and fires on the first
  `audit_events_rejected_total{status="write_failed"}` increase. It returns to inactive after five minutes without another write failure.
- `AuditOutboxBacklogGrowing` is warning-level and fires separately for the bounded `audit_delivery` and `external_operations` queue values when their total remains above the value from 15 minutes earlier for five minutes. It returns to inactive once that growth condition clears.

Both rules aggregate away `event_type` and `status`. Their alert labels contain only static service metadata and the bounded `queue` value; do not add chat, tenant, user, subject, correlation, idempotency, or other business identifiers.

Validate syntax and behaviour with:

```bash
promtool check rules monitoring/prometheus/audit-alerts.yml
promtool test rules monitoring/prometheus/audit-alerts.test.yml
```

## Audit write and outbox recovery

Use this procedure for `AuditMandatoryWriteFailed`, `AuditOutboxBacklogGrowing`, or an unhealthy audit section in `GET /health`.

### 1. Capture safe diagnostics

Run the aggregate diagnostic command from the same release and environment as the bot:

```bash
npm run audit:diagnose
```

It reads only counts and oldest-age values. Do not replace it with queries that select `before`, `after`, `payload`, `metadata`, Telegram context, subject identifiers, or idempotency keys. Correlate the result with these structured log events:

- `database.pool.idle_client_error`, `database.client.connection_error`, `health.audit_state_failed` — PostgreSQL connectivity;
- `pending_operations.worker.tick_failed`, `pending_operations.recover.no_resolver` — recovery worker or deployment mismatch;
- `pending_operations.audit.finalization_failed` and `audit.*.failed` — mandatory audit finalization;
- `pending_operations.recover.unknown_non_retryable` — an interrupted operation that must not be replayed blindly.

The fields have distinct meanings:

| Field | Meaning | Normal recovery path |
| --- | --- | --- |
| `delivery.pending` / `delivery.failed` | An audit event is already committed; its separate `audit.outbox` delivery is unfinished. | Restore the owning downstream consumer and require its acknowledgement before it marks the row delivered. |
| `externalOperations.pending` / `inProgress` | External work was written ahead but has not reached a confirmed outcome. | Restore the provider and restart or leave the worker running. Expired leases are reclaimed automatically. |
| `externalOperations.retryScheduled` | The outcome was unconfirmed and a retry is waiting for its backoff. | Wait for `next_attempt_at`; do not clear leases or force the status. |
| `externalOperations.auditPending` | The external operation is terminal, but its required audit write failed. | The worker retries only audit finalization and does not invoke the provider again. |
| `externalOperations.terminalUnknown` | Retries are exhausted or replay is unsafe, so the outcome is genuinely unknown. | Reconcile with the provider using its read API; never convert it to success or failure without evidence. |

### 2. Restore dependencies before replay

1. Restore PostgreSQL connectivity and confirm migrations for the deployed commit are applied.
2. Restore the affected Telegram, S3, or RabbitMQ endpoint and credentials.
3. Confirm the deployed release registers a resolver for every logged operation `kind`. A `recover.no_resolver` warning is a code/deployment mismatch, not permission to edit the row.
4. Stop the unhealthy instance gracefully when possible so `stopAndDrain()` can finish the current sweep. Do not run ad-hoc SQL updates against status, lease, payload, result, or audit columns.

A direct mandatory audit write failure rejects and rolls back its enclosing business transaction. After PostgreSQL is healthy, let the original idempotent command/update path be redelivered; do not insert a replacement audit event manually. For an already-completed external operation with `auditPending > 0`, use only the worker recovery below—the external effect must not be repeated.

### 3. Recover and verify

Deploy or restart the same fixed release. Bootstrap runs one `recoverPending()` sweep before Telegram traffic starts, then `startWorker()` continues polling. Multiple instances coordinate using leases and `FOR UPDATE SKIP LOCKED`; do not release their locks manually.

Verify all of the following:

1. `GET /health` returns audit `ready`, or `degraded` only for a separately understood terminal condition.
2. `npm run audit:diagnose` shows `auditPending = 0` and no aged unfinished external operations.
3. `audit_outbox_pending` stops growing and returns to the expected baseline for both queue values.
4. `AuditMandatoryWriteFailed` becomes inactive after five minutes without another failure.
5. Logs contain no new `worker.tick_failed`, `recover.no_resolver`, or `audit.finalization_failed` events.

`audit.outbox` is not the write-ahead external-operation queue, and this repository does not ship its downstream dispatcher. Restarting the bot cannot truthfully acknowledge those delivery rows. Never mark them `delivered` or delete them merely to clear an alert; repair the configured consumer first and preserve idempotent delivery by event identity.

### 4. Run the recovery drill

Run this only with `TEST_DATABASE_URL` pointing to an isolated test database:

```bash
npm test -- --run tests/integration/auditRecovery.test.ts
```

The drill creates rows under a unique `bots12-recovery-drill-*` owner, simulates a successful external call followed by an audit outage, constructs a fresh worker, and verifies that recovery writes the audit exactly once without repeating the external call. Its cleanup deletes only that owner-scoped synthetic data.

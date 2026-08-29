# Recovery and monitoring

## Scope and safe evidence

This runbook covers PostgreSQL, audit persistence, both outbox models, replay, and audit retention. Use the exact deployed release when running repository commands. Operational evidence must contain counts, ages, bounded statuses, and static service metadata only; do not query or copy `before`, `after`, `payload`, `request_payload`, `recovery_metadata`, Telegram context, subject identifiers, or idempotency keys into tickets or alerts.

The loopback operational server exposes `GET /health` and `GET /metrics`. Run the aggregate database diagnostic from the same environment as the bot:

```bash
npm run audit:diagnose
```

The output has two independent queue groups:

| Diagnostic group | Stored model | Meaning | Owner |
| --- | --- | --- | --- |
| `delivery.*` | `audit.outbox` | An audit event is committed; delivery of its sanitized copy is unfinished. | The downstream consumer, which is not shipped by this repository. |
| `externalOperations.*` | `moderation.pending_operations` | An external Telegram, S3, RabbitMQ, reply, command-menu, or command-audit operation or its required audit finalization is unfinished. | This application's leased recovery worker and the registered operation resolver. |

Never use one queue as evidence about the other. Restarting the bot can recover `externalOperations`, but it cannot acknowledge `audit.outbox` delivery.

Other established recovery boundaries still apply. PostgreSQL remains authoritative when optional Redis or S3 is degraded. An enabled RabbitMQ outage blocks rollout until AMQPS health and retry/DLQ state recover. A closed forum topic does not fall back to the parent chat unless the command contract and `TELEGRAM_TOPIC_FALLBACK_TO_CHAT` explicitly allow it. After a PostgreSQL restore, preserve the seven-day processed-update idempotency window and do not replay business effects outside their normal handlers.

## Alerts and common signals

Prometheus must scrape `GET /metrics` and load [`monitoring/prometheus/audit-alerts.yml`](../../monitoring/prometheus/audit-alerts.yml). Alertmanager routing remains deployment-specific.

- `AuditMandatoryWriteFailed` is critical. It fires when `audit_events_rejected_total{status="write_failed"}` increases and becomes inactive after five minutes without another failure.
- `AuditOutboxBacklogGrowing` is warning-level. It evaluates `audit_outbox_pending` separately for the bounded `audit_delivery` and `external_operations` queue labels and fires when a non-zero total remains above its value from 15 minutes earlier for five minutes.

Validate the rules with the same `promtool` version used in the environment:

```bash
promtool check rules monitoring/prometheus/audit-alerts.yml
promtool test rules monitoring/prometheus/audit-alerts.test.yml
```

Relevant structured log events are:

- `database.pool.idle_client_error`, `database.client.connection_error`, `health.audit_state_failed`, `bootstrap.failed`;
- `pending_operations.worker.tick_failed`, `pending_operations.recover.no_resolver`, `pending_operations.recover.unknown_non_retryable`;
- `pending_operations.audit.finalization_failed` and `audit.*.failed`;
- `database.migrations.completed` and `bootstrap.completed` as positive startup evidence.

Retention completion is a persisted `audit.retention.completed` audit event, not a logger event; the retention command also prints a bounded job/count summary after commit.

## Incident: PostgreSQL is unavailable

**Detection.** `GET /health` returns HTTP 503 with `database: "unhealthy"` and null audit counts, `npm run audit:diagnose` fails, bootstrap does not reach `database.migrations.completed`, or database connection errors appear in logs.

**Business impact.** A new instance stops before accepting Telegram traffic. On a running instance, database-backed commands, idempotency, module settings, required audit writes, and outbox recovery cannot complete. Optional Redis behaviour does not provide a database fallback.

**Safe diagnosis.** Confirm the incident across more than one instance, then check DNS, routing, TLS certificate validity, PostgreSQL availability, connection limits, and the application's role login from the deployment network. Compare the deployed migration set with the environment's Drizzle history without selecting business tables or printing connection URLs.

**Restore the dependency.** Restore PostgreSQL and the TLS/role configuration first. Confirm the deployed commit's migrations can complete under the migration owner, then restart or replace affected instances normally.

**Replay or reconciliation.** Bootstrap runs migrations and one `recoverPending()` sweep before Telegram transport starts; the worker continues afterward. Allow Telegram redelivery and the idempotency gates to resume local work. Let `pending_operations` recovery handle recorded external intents. No action against `audit.outbox` is implied by database recovery; its consumer remains responsible for delivery.

**Verify recovery.** Require `database.migrations.completed`, `bootstrap.completed`, HTTP 200 from `GET /health`, `database: "ready"`, non-null audit counts, a successful `npm run audit:diagnose`, and no new connection errors. Confirm queue ages and counts trend toward their established baseline.

**Forbidden actions and escalation.** Do not disable TLS, substitute the retention role for the application role, edit `drizzle.__drizzle_migrations`, truncate queues, or manually mark work completed. Escalate to the PostgreSQL owner if connectivity is unstable, migration history differs from the release, role grants changed, or the restored schema does not match a clean migration of the same commit.

## Incident: an outbox backlog is growing

**Detection.** `AuditOutboxBacklogGrowing` fires, `audit_outbox_pending` rises for either queue label, or `npm run audit:diagnose` shows increasing counts or oldest ages. `GET /health` becomes degraded for failed audit delivery, audit debt, or external work older than five minutes; a merely pending audit-delivery row does not by itself degrade health.

**Business impact.** For `audit_delivery`, source events remain committed but downstream consumers receive them late. For `external_operations`, provider calls, results, replies, or mandatory audit finalization may be delayed; terminal `unknown` means the provider result cannot be proven.

**Safe diagnosis.** Identify the queue label first. For `delivery.*`, check the owning consumer's availability and acknowledgement errors. For `externalOperations.*`, compare `pending`, `inProgress`, `retryScheduled`, `auditPending`, `terminalUnknown`, and `oldestUnfinishedAgeSeconds`; inspect only structured worker log event names and bounded `kind`/status data.

**Restore the dependency.** Restore the audit-delivery consumer for `audit_delivery`. For `external_operations`, restore the affected provider and database, verify the deployed release registers a resolver for every logged `kind`, and restart the same fixed release if its worker is unhealthy.

**Replay or reconciliation.** The downstream consumer must redeliver by immutable event identity and acknowledge only after its destination confirms receipt. The application worker automatically reclaims expired leases and honours `next_attempt_at`; `auditPending` retries audit finalization without invoking the provider again. Reconcile terminal `unknown` through a provider read API when one exists.

**Verify recovery.** The alert becomes inactive, queue counts stop growing and return to the environment baseline, oldest ages fall, `auditPending` reaches zero, and logs have no new worker/finalization errors. `GET /health` must be `ready` or degraded only for a separately documented terminal condition.

**Forbidden actions and escalation.** Do not delete rows, clear leases, overwrite status/result/payload fields, mark audit delivery `delivered`, or replay a provider call from copied payload data. Escalate when the owner consumer is unknown, a resolver is missing, counts still grow after the dependency is healthy, or a terminal unknown cannot be reconciled safely.

## Incident: a mandatory audit record was not saved

**Detection.** `AuditMandatoryWriteFailed` fires, `recentWriteFailure` is true in health, `audit_events_rejected_total{status="write_failed"}` increases, or logs contain `pending_operations.audit.finalization_failed` or the relevant `audit.*.failed` event.

**Business impact.** A local business mutation and its mandatory audit write share one transaction, so the local mutation is rolled back. An external provider call cannot share that transaction: it may already have completed while `pending_operations.audit_status` remains `pending`, leaving audit debt but not permission to repeat the side effect.

**Safe diagnosis.** Confirm PostgreSQL health and migrations, identify whether `externalOperations.auditPending` increased, and correlate by timestamp, service instance, and log event name. Distinguish validation or policy rejection from `write_failed`; only the latter drives this alert.

**Restore the dependency.** Restore PostgreSQL or the audit write path. For an audit schema/registry mismatch, deploy a reviewed compatible code fix; do not weaken validation or make a mandatory event disableable.

**Replay or reconciliation.** For a rolled-back local mutation, rely on Telegram redelivery or repeat the action through the normal authenticated command path after product/operator approval. For `auditPending`, let the recovery worker write only the owed audit record; it must not call the external provider again. Stable idempotency keys make either path converge on one event.

**Verify recovery.** `externalOperations.auditPending` is zero, a normal non-sensitive state change can commit with its audit event, no new write-failure counter increase occurs, health loses `recentWriteFailure` after five minutes, and `AuditMandatoryWriteFailed` becomes inactive.

**Forbidden actions and escalation.** Do not insert an audit event manually, suppress the alert, disable the event, or report the business action successful without persisted audit evidence. Escalate immediately if a local mutation survived without its required event, duplicate external effects are observed, or audit finalization remains blocked after database recovery.

## Incident: repeat processing is required

**Detection.** `externalOperations.pending`, `inProgress`, `retryScheduled`, or `auditPending` remains above zero; oldest unfinished age grows; logs report worker failure, expired work, missing resolver, or non-retryable unknown; or the recovery drill fails.

**Business impact.** A recorded intent or its audit may be incomplete. Retrying too early can duplicate an external effect; refusing all replay can strand recoverable work. The stored status and resolver policy decide which case applies.

**Safe diagnosis.** Run `npm run audit:diagnose`, verify provider health, and confirm the same deployed release owns the operation kinds. Use the status model: `pending` is not called, `in_progress` may have an active or expired lease, `retryScheduled` waits for backoff, `auditPending` owes only audit, and `terminalUnknown` has no safe automatic conclusion.

**Restore the dependency.** Restore PostgreSQL and the relevant Telegram/S3/RabbitMQ endpoint. Gracefully stop an unhealthy instance when possible so `stopAndDrain()` finishes its current sweep, then start the fixed release with the same owner identity and resolver set.

**Replay or reconciliation.** Startup performs recovery before new Telegram traffic and the worker continues using leases plus `FOR UPDATE SKIP LOCKED`. Wait for scheduled backoff. Retry only operation kinds whose resolver allows retry after unknown. For non-retryable unknown, use a provider read API and preserve `unknown` when no authoritative evidence exists. `auditPending` finalizes audit only.

**Verify recovery.** Counts and oldest age decrease, `auditPending` reaches zero, no resolver/worker errors recur, and repeated delivery resolves through the existing idempotency record rather than another provider call. In Test, validate the mechanism with:

```bash
npm test -- --run tests/integration/auditRecovery.test.ts
```

The command requires `TEST_DATABASE_URL` to point to an isolated test database. It creates owner-scoped synthetic rows, simulates an external success followed by an audit outage, and verifies that a fresh worker writes the audit exactly once without repeating the external call; cleanup removes only those synthetic rows.

**Forbidden actions and escalation.** Do not force `next_attempt_at`, clear `worker_id` or leases, clone rows, invent a result, or replay from an ad hoc script. Escalate when a resolver is absent, the logical operation is not idempotent, provider evidence conflicts with the stored outcome, or the retry budget is exhausted.

## Incident: audit retention finished with an error

**Detection.** The scheduler records a non-zero exit from `npm run audit:retention`, stderr contains `Audit retention job failed`, the expected successful job output is absent, or no corresponding `audit.retention.completed` record is available through the authorized audit read path. There is no dedicated retention Prometheus alert in this repository, so the scheduler must alert on exit status and missing expected execution.

**Business impact.** Expired events remain longer than their captured policy permits until a successful rerun. The deletion batch and its mandatory completion event execute in one audit transaction, so a failed completion does not authorize assuming the deletion committed.

**Safe diagnosis.** Check PostgreSQL/TLS availability, scheduler logs, migrations, and that `AUDIT_RETENTION_DATABASE_URL` uses the dedicated role described in [the retention-role guide](audit-retention-role.md). Confirm the role has the migration-defined grants without printing the URL or selecting event payloads. Check whether another retention run is active before retrying.

**Restore the dependency.** Restore PostgreSQL and the secret-store credential for the dedicated retention login. Apply missing reviewed migrations with the migration owner; do not grant the normal application role deletion rights.

**Replay or reconciliation.** Rerun `npm run audit:retention` normally after the cause is fixed. Each invocation uses a fresh job identifier and deletes at most the configured batch size, ordered oldest first. Continue scheduled batches rather than issuing a broad delete; policy is read from the value captured with each event.

**Verify recovery.** Require exit code zero and the `audit retention job <jobId> deleted <count> event(s)` summary, confirm `audit.retention.completed` through the authorized audit read path, and verify the next scheduled run also succeeds. A zero deletion count is valid when nothing is expired.

**Forbidden actions and escalation.** Do not run manual `DELETE`/`TRUNCATE`, edit captured retention policy, delete unfinished outbox work, reuse `DATABASE_URL`, or broaden role grants. Escalate when the limited role cannot complete after migrations, completion evidence is missing after an exit-zero run, expired data continually accumulates, or a retention change would affect legal/product policy.

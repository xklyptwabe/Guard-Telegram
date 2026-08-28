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

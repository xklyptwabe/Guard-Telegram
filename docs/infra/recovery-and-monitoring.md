# Recovery and monitoring

Monitor bootstrap/migration failure, transport start/stop, duplicate-update skips, command failures, optional-service degradation, RabbitMQ retry/DLQ, database pool errors, and process restarts. Alerts must use metadata only; do not forward message bodies or callback data.

For Redis/S3 degradation, retain the service but investigate the TLS endpoint and credentials; PostgreSQL remains authoritative. For an enabled RabbitMQ outage, prevent new deployment rollout until AMQPS health is restored, then inspect retry and DLQ counts before replaying any action with an idempotent handler.

For a closed forum topic, the default is no parent-chat message. Enable fallback only for a command whose product contract explicitly permits it. Database recovery follows the PostgreSQL backup/restore runbook; after restore, use the seven-day idempotency window to avoid replaying business effects.

# ADR 0006: business audit architecture

The business audit is an independent PostgreSQL-backed subsystem. `AuditService` is its write boundary; the JSON logger remains operational telemetry, and the in-process EventBus remains a best-effort application mechanism. Neither is a source of audit truth and neither may be used to acknowledge a required audit record.

## Local state changes

`AuditService.recordEntityChange` owns one Drizzle transaction containing the business mutation, policy resolution, the audit event, its delivery outbox row, and the updated entity snapshot. The caller performs its database mutation through the supplied transaction and returns the state that was actually persisted. Any failure in a required audit write aborts that same transaction, so the business change cannot succeed without its audit record.

An idempotency key identifies one logical operation. Reusing it for the same operation returns the existing event; reusing it for different event identity is rejected. Before mutation, the service creates or locks the subject's `audit.entity_snapshots` row with `FOR UPDATE`. Its `last_subject_sequence` supplies a deterministic per-tenant, per-subject order even when workers execute concurrently. Missing state remains `not_observed`/SQL `NULL`; it is never replaced by fabricated JSON.

The registered event definition and effective policy are resolved before persistence. Schema validation, allowlisting, snapshot mode, and masking are applied before data reaches `audit.events`, `audit.entity_snapshots`, or `audit.outbox`. Definitions with `canBeDisabled: false` are protected by the registry and database policy constraints. A caller may skip an event only when its registered policy permits that outcome; an unavailable or failed required audit remains a failed operation.

## External operations

A PostgreSQL transaction cannot atomically include Telegram, S3, or RabbitMQ. These effects use `moderation.pending_operations` as a write-ahead record before the provider call. A leased worker classifies a confirmed response as `succeeded` or `failed`; a timeout or transport failure is `unknown` because the provider may already have applied the effect. Safe operations retry with the same idempotency identity, while unsafe or exhausted outcomes require reconciliation. Startup recovery and the continuous worker reclaim expired leases without repeating an already-finalized audit.

Every terminal external outcome owes one final audit event. If the external effect completed but audit finalization failed, the pending-operation row keeps `audit_status = 'pending'`; recovery retries only the audit write, not the provider call. A deliberate `policy_skipped` result is valid only for an event whose policy allows it. This preserves the distinction between an optional record and unpaid mandatory audit debt.

`audit.outbox` is different: it represents downstream delivery of an audit event that is already committed. This repository does not ship that downstream dispatcher. Delivered rows may be removed by retention; unfinished delivery debt is preserved when its source event expires, with the event reference cleared rather than the pending payload silently discarded. Operators must restore the owning consumer instead of marking rows delivered by hand.

## Storage and roles

`audit.events` is append-only for the application role: ordinary runtime access cannot update or delete recorded events. Application updates are limited to the columns needed for snapshots and policy locking. Retention runs through the separate `audit_retention` role, which can select the registry and policies and perform the narrow event, outbox, and snapshot operations required by the batch job, but cannot rewrite events or policies.

Retention deletes bounded batches according to the policy captured with each event and records `audit.retention.completed` in the same audited job flow. Application rollback never deletes production history or rewrites an applied migration; schema corrections are forward-only.

## Consequences

- Local required audit is fail-closed and transactionally consistent.
- External effects are recoverable, but an unconfirmed provider outcome remains explicitly `unknown`.
- Duplicate delivery does not create duplicate audit events.
- Event order is stable per audited subject, not a claim of global Telegram delivery order.
- Privacy enforcement occurs before persistence, not only when data is read back.
- Operational logs, metrics, and health expose bounded metadata and counts, never audit snapshots or secrets.

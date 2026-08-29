# Audit privacy contract

## Purpose and sources of truth

This document defines the maximum data the audit subsystem may persist, expose, or export. It is a boundary, not a description of every field that is always present. Each event's Zod schema and static allowlist in `src/lib/audit/definitions.ts` remain the field-level source of truth; the complete mapping is in the [event catalog](event-catalog.md).

The effective policy for a chat and event type can only narrow that maximum. It cannot make a field safe merely by naming it. The persistence path applies the controls in this order:

1. validate an observed snapshot against the registered Zod schema;
2. project it through the event definition's allowlist;
3. intersect it with the effective policy allowlist and apply policy masking;
4. recursively remove forbidden keys and redact recognizable credential values;
5. persist the same sanitized representation to the event, entity snapshot, and audit outbox.

Missing, redacted, unknown, and not-applicable state is represented by an explicit snapshot status. The service does not replace unavailable data with an empty object or a fabricated value.

## Data that may be stored

Subject to the event schema, static allowlist, and effective policy, an audit record may contain:

- event identity and lifecycle data: event type and version, category, source, status, timestamps, ordering sequence, correlation key, and idempotency key;
- tenant, actor, and subject identifiers and types needed to scope and order the record;
- the allowlisted Telegram context keys `correlationId`, `updateId`, `chatId`, `userId`, and `messageThreadId`;
- validated `before`, `after`, `changes`, and current entity snapshot fields listed for that event in the [event catalog](event-catalog.md);
- operational metadata limited to `source`, `moduleId`, `operation`, `reason`, `auditPolicy`, and `truncated`, plus fields explicitly allowed by the event definition;
- the minimum typed operation identity and provider arguments needed to retry or reconcile an external moderation operation, after the same forbidden-data filtering.

Identifiers are still treated as untrusted strings. A value that resembles a credential is rejected from required event-envelope fields or omitted/redacted from nested data rather than being stored as an identifier.

## Data that must never be stored

Audit events, snapshots, outboxes, exports, logs, and operational responses must not contain:

- bot tokens, API keys, passwords, private keys, credentials, or webhook secrets;
- authorization values, request or response headers, cookies, database connection strings, DSNs, or URLs containing credentials;
- a raw Telegram `Update` object or an unfiltered provider response;
- raw callback data, callback-query payloads, or command payloads;
- files, file bytes, message attachments, file identifiers, file paths, or file URLs;
- arbitrary request bodies or the contents of an object-storage upload;
- unfiltered exception data when its message can contain a credential or connection string.

`src/lib/audit/masking.ts` enforces this contract defensively even after schema validation and allowlisting. Key matching covers camelCase, snake_case, and kebab-case forms. High-confidence secret patterns in otherwise allowed free text are redacted as `[redacted]`.

## Message text

Message bodies are denied by default. Text can be persisted only when all of the following are true:

1. the registered event schema contains the `text` field;
2. the event definition marks `text` as conditional on `allowMessageTextLogging`;
3. the resolved policy explicitly includes `text` in its allowlist;
4. policy masking does not redact it;
5. the global forbidden-value filter does not redact it.

Enabling text for one event type does not enable it for another event or chat. A `metadata` snapshot policy stores no snapshot values, including text. Changes and the current entity snapshot pass through the same effective policy, so text cannot reappear through a secondary persistence path.

## Reads, exports, retention, and operational surfaces

Backend reads are tenant-scoped and role-limited. Export is denied by default, requires the effective policy to set `exportAllowed`, reapplies the current allowlist and masking before serialization, and creates its own `audit.exported` event. A policy's `retentionDays`, when set, is captured with the event for the restricted retention job; a null value does not authorize an ad hoc deletion.

Health, Prometheus metrics, alert inputs, and `audit:diagnose` output contain aggregate dependency, queue, rejection, and age/count information only. They must not expose audit snapshots, event metadata, Telegram context, provider payloads, or business identifiers. Application logs follow the same boundary and must use structured redaction instead of logging raw updates or requests.

## Review and regression checks

Changes to an audit schema, allowlist, policy resolution, masking, export, or external-operation payload require a privacy review against this contract. The existing regression coverage is concentrated in:

- `tests/unit/audit.masking.test.ts`;
- `tests/unit/audit.persistenceValidation.test.ts`;
- `tests/unit/auditService.safety.test.ts`;
- `tests/unit/audit.exportService.test.ts`;
- `tests/unit/audit.metrics.test.ts`;
- `tests/unit/health.test.ts` and `tests/unit/operationalServer.test.ts`.

An allowlist addition is a data-retention decision. It must not be treated as a harmless serialization change.

import type { SnapshotStatus } from './enums.js';
import type { AuditEventName } from './eventMap.js';
import { auditEventRegistry, type AuditEventRegistry } from './registry.js';
import type { AuditRecord } from './types.js';

/**
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * BOTS-7 (this registry) and BOTS-6 (`src/lib/auditService.ts`, evilstealer
 * branch) were built against different mental models of "an audit event":
 *
 *   BOTS-7:  a flat record — eventName, operation, before/after/changes,
 *            chatId — produced once the underlying mutation has already
 *            happened.
 *   BOTS-6:  `AuditService.recordEntityChange(input, mutate)` — a
 *            transactional wrapper where `mutate` performs the actual DB
 *            write *inside* the audit transaction and returns
 *            before/after/changes/snapshotData. Identity is
 *            tenantId/subjectType/subjectId (+ subjectSequence), not chatId.
 *
 * This file is the translation layer between the two, built entirely from
 * what is actually confirmed in BOTS-6 commit 7e9174b — not from guesses
 * presented as fact. Three things below are NOT solved by this file and are
 * called out loudly rather than silently papered over:
 *
 *   1. ATOMICITY GAP — CONFIRMED by Maxim directly (01.08, in chat):
 *      "[recordEntityChange] принимает уже подготовленные безопасные
 *      данные, сам делает транзакцию, проверку policy, защиту от дубля,
 *      запись event/snapshot/outbox" — i.e. BOTS-7's job stops at handing
 *      over already-validated/masked/allowlisted values; BOTS-6 owns the
 *      transaction, policy check, dedup, and the actual write. That still
 *      means the real business mutation has to happen *inside* `mutate`
 *      (using the `tx` it's given), with this registry's validate → mask
 *      → allowlist pipeline applied to `mutate`'s return value — not
 *      called after the fact on an already-finished `AuditRecord`. If a
 *      caller already has a finished `AuditRecord` and wraps it in a
 *      no-op `mutate`, the transactional guarantee is gone in practice,
 *      because the business write already happened separately before this
 *      function ever runs. `toMutate()` below is only safe to use that
 *      way for events that have no real "mutation" of their own to
 *      protect (see EVENT_SUBJECTS[...].sequenceFit === 'log-like'). For
 *      entity-like events, follow the pattern BOTS-6 already used for
 *      `module.state.changed` in `ModuleRegistry.setEnabled()`.
 *
 *   2. TENANT GAP — RESOLVED (02.08, reviewed with Maxim). `audit.policy.changed`,
 *      `integration.action`, `audit.exported`, and `audit.retention.completed`
 *      have no `chatId` (see `shapes.ts`) — platform-level events. BOTS-6's
 *      `AuditIdentity.tenantId` is required and, per
 *      `docs/adr/0003-chat-is-tenant.md`, *is* chat_id. Agreed approach:
 *      `PLATFORM_TENANT_SENTINEL` for genuinely tenant-less events, except
 *      `audit.policy.changed`, where a chat-scoped policy's own `scope`
 *      field *is* the chatId and should be used as `tenantId` directly (see
 *      `tenantIdFor`). Convention assumed here: `scope === 'global'` means
 *      platform-wide (falls back to the sentinel); any other `scope` value
 *      is treated as a chatId. That literal ('global') is this adapter's
 *      choice, not something Maxim specified byte-for-byte — worth a quick
 *      confirmation if `chat.settings`-style policies ever use a different
 *      convention for "not chat-scoped".
 *
 *   3. SUBJECT/SEQUENCE FIT — model CONFIRMED workable (02.08, Maxim: "по
 *      subjectSequence — подходит", "snapshots — формальный"), including
 *      for the 4 log-like events (`command.executed`, `integration.action`,
 *      `audit.exported`, `audit.retention.completed`) — a nominal/formal
 *      snapshot there is fine, not a modeling mismatch. What's still open
 *      is only the exact subjectType/subjectId *values* for 11 of 12
 *      events — only `module.state.changed`'s is confirmed against real
 *      BOTS-6 code, the rest remain `confirmed: false` reasoned proposals
 *      pending his sign-off.
 *
 * severity / siteVisible / canBeDisabled — RESOLVED: these are static,
 * per-event-type metadata, not per-occurrence data, so they don't belong on
 * every event row's `metadata` at all. They now live as real columns on
 * `audit.event_types` (see `src/db/schema/audit.ts` and
 * `scripts/seedAuditEventTypes.ts`, which seeds that table from this
 * registry's `definitions.ts`). The `metadata.bots7` bridge for them has
 * been removed accordingly.
 *
 * operation — per Maxim: goes into `metadata.operation` for filtering/
 * analytics, `changes` should carry the *full* ChangeSet (status + fields,
 * or status + reason when unavailable), not just a flattened fields object.
 * Both are implemented below. The catch: for entity-like events, `metadata`
 * is part of `AuditEventInput`, built *before* `mutate` runs — and
 * `operation` (e.g. noop vs update for module.state.changed) is often only
 * knowable *inside* `mutate`, after reading the row. Maxim's own
 * assessment: not critical right now, addressed in a later refactor
 * (presumably extending `AuditMutationResult` so `mutate` can supply
 * metadata too). Until then, `buildMetadataBridge(record)` — which needs a
 * fully-known `AuditRecord` — only works for events where before/after are
 * knowable upfront (the log-like ones). For entity-like events wired
 * through `mutate` (like `module.state.changed`), no `metadata.operation`
 * is set — there is currently nowhere correct to put it.
 * ============================================================================
 */

/**
 * Sentinel tenantId for genuinely platform-level events (no chatId at
 * all). Reviewed and agreed with Maxim — no longer a compile-only
 * placeholder. See "TENANT GAP — RESOLVED" above.
 */
export const PLATFORM_TENANT_SENTINEL = '__platform__';

/** Mirror of `AuditIdentity` from `src/lib/auditService.ts` (BOTS-6). */
export interface DownstreamAuditIdentity {
  readonly tenantId: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

/** Mirror of `AuditEventInput` from `src/lib/auditService.ts` (BOTS-6). */
export interface DownstreamAuditEventInput extends DownstreamAuditIdentity {
  readonly eventType: string;
  /** BOTS-6 models this as a string ('v1'); BOTS-7's `eventVersion` is a number. */
  readonly eventVersion: string;
  readonly category: string;
  readonly source: string;
  readonly idempotencyKey: string;
  /**
   * Feeds BOTS-8's hierarchical policy resolution (global → chat → module →
   * event_type). Without it, a module-level policy override can never
   * apply to this event — silently falls back to chat/global. Populated
   * generically below whenever the observed snapshot carries a `moduleId`
   * field (true for `module.state.changed` and `command.executed` today).
   */
  readonly moduleId?: string;
  readonly actorId?: string;
  readonly actorType?: string;
  readonly correlationId?: string;
  readonly telegramContext?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

/** Mirror of the `mutate` callback's return shape (`AuditMutationResult`) in BOTS-6. */
export interface DownstreamAuditMutationResult {
  readonly before: Record<string, unknown> | undefined;
  readonly after: Record<string, unknown> | undefined;
  readonly beforeSnapshotStatus: SnapshotStatus;
  readonly afterSnapshotStatus: SnapshotStatus;
  readonly changes?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly snapshotStatus: 'current' | 'archived';
  readonly snapshotData: Record<string, unknown>;
}

interface SubjectMapping {
  readonly subjectType: string;
  readonly subjectId: string;
  /** true only for mappings copied verbatim from real BOTS-6 code. */
  readonly confirmed: boolean;
  /** See "SUBJECT/SEQUENCE FIT" above. */
  readonly sequenceFit: 'entity' | 'log-like';
}

/** Reads a field out of whichever snapshot side is actually observed. */
function readObservedField(record: AuditRecord, key: string): unknown {
  if (record.after.status === 'observed') {
    const value = (record.after.data as Record<string, unknown>)[key];
    if (value !== undefined) return value;
  }
  if (record.before.status === 'observed') {
    return (record.before.data as Record<string, unknown>)[key];
  }
  return undefined;
}

export class MissingAuditChatIdError extends Error {
  public constructor(eventName: string) {
    super(`serviceAdapter: "${eventName}" requires a chatId.`);
    this.name = 'MissingAuditChatIdError';
  }
}

export class MissingAuditSubjectIdentityError extends Error {
  public constructor(eventName: string, fieldName: string) {
    super(`serviceAdapter: "${eventName}" requires observed subject identity field "${fieldName}".`);
    this.name = 'MissingAuditSubjectIdentityError';
  }
}

export class MissingAuditIdempotencyKeyError extends Error {
  public constructor(eventName: string) {
    super(`serviceAdapter: "${eventName}" requires an explicit idempotencyKey.`);
    this.name = 'MissingAuditIdempotencyKeyError';
  }
}

export class MissingAuditSnapshotDataError extends Error {
  public constructor(eventName: string, afterStatus: SnapshotStatus) {
    super(`serviceAdapter: "${eventName}" cannot build entity snapshot data from after status "${afterStatus}".`);
    this.name = 'MissingAuditSnapshotDataError';
  }
}

function requireObservedString(record: AuditRecord, fieldName: string): string {
  const value = readObservedField(record, fieldName);
  if (typeof value === 'string' && value.length > 0) return value;
  throw new MissingAuditSubjectIdentityError(record.eventName, fieldName);
}

function isChatScopedEvent(eventName: AuditEventName): boolean {
  return (
    eventName === 'module.state.changed' ||
    eventName === 'chat.settings.changed' ||
    eventName === 'member.status.changed' ||
    eventName === 'bot.membership.changed' ||
    eventName === 'moderation.action' ||
    eventName === 'message.edited' ||
    eventName === 'message.deleted' ||
    eventName === 'command.executed'
  );
}

function chatIdFor(record: AuditRecord): string {
  if (record.chatId !== undefined && record.chatId.length > 0) return record.chatId;
  const observedChatId = readObservedField(record, 'chatId');
  if (typeof observedChatId === 'string' && observedChatId.length > 0) return observedChatId;
  throw new MissingAuditChatIdError(record.eventName);
}

/**
 * Per-event subject mapping. Only `module.state.changed` is `confirmed:
 * true` — everything else is a reasoned proposal, not a fact. Re-check the
 * "SUBJECT/SEQUENCE FIT" note above before trusting the rest in production.
 */
function subjectMappingFor(record: AuditRecord): SubjectMapping {
  const eventName = record.eventName as AuditEventName;
  const chatId = () => chatIdFor(record);

  switch (eventName) {
    case 'module.state.changed': {
      // CONFIRMED — copied from ModuleRegistry.setEnabled() in BOTS-6
      // commit 7e9174b: subjectType 'chat_module_state', subjectId
      // `${chatId}:${moduleId}`.
      const moduleId = requireObservedString(record, 'moduleId');
      return { subjectType: 'chat_module_state', subjectId: `${chatId()}:${moduleId}`, confirmed: true, sequenceFit: 'entity' };
    }
    case 'chat.settings.changed':
      return { subjectType: 'chat_settings', subjectId: chatId(), confirmed: false, sequenceFit: 'entity' };
    case 'member.status.changed': {
      const userId = requireObservedString(record, 'userId');
      return { subjectType: 'chat_member', subjectId: `${chatId()}:${userId}`, confirmed: false, sequenceFit: 'entity' };
    }
    case 'bot.membership.changed':
      return { subjectType: 'bot_membership', subjectId: chatId(), confirmed: false, sequenceFit: 'entity' };
    case 'moderation.action': {
      // Proposed as an entity (the target's moderation state within the
      // chat) rather than a one-off log line, so a moderation history per
      // member is queryable via subjectSequence. Confirm this framing with
      // BOTS-6 before relying on it.
      const targetUserId = requireObservedString(record, 'targetUserId');
      return { subjectType: 'chat_member_moderation', subjectId: `${chatId()}:${targetUserId}`, confirmed: false, sequenceFit: 'entity' };
    }
    case 'message.edited':
    case 'message.deleted': {
      // Both map to the same subject (the message itself) so an edit
      // followed by a delete forms one sequence for that message.
      const messageId = requireObservedString(record, 'messageId');
      return { subjectType: 'message', subjectId: `${chatId()}:${messageId}`, confirmed: false, sequenceFit: 'entity' };
    }
    case 'audit.policy.changed': {
      // No chatId on this event at all — see TENANT GAP above. subjectId
      // uses policyId since that's the actual entity being changed.
      const policyId = requireObservedString(record, 'policyId');
      return { subjectType: 'audit_policy', subjectId: policyId, confirmed: false, sequenceFit: 'entity' };
    }
    case 'command.executed': {
      // Log-like: every invocation is independent, there is no ongoing
      if (record.idempotencyKey === undefined || record.idempotencyKey.length === 0) {
        throw new MissingAuditIdempotencyKeyError(record.eventName);
      }
      return { subjectType: 'command_execution', subjectId: record.idempotencyKey, confirmed: false, sequenceFit: 'log-like' };
    }
    case 'integration.action': {
      const targetType = requireObservedString(record, 'targetType');
      const targetId = requireObservedString(record, 'targetId');
      return { subjectType: `integration_${targetType}`, subjectId: targetId, confirmed: false, sequenceFit: 'log-like' };
    }
    case 'audit.exported': {
      const exportId = requireObservedString(record, 'exportId');
      return { subjectType: 'audit_export', subjectId: exportId, confirmed: false, sequenceFit: 'log-like' };
    }
    case 'audit.retention.completed': {
      const jobId = requireObservedString(record, 'jobId');
      return { subjectType: 'audit_retention_job', subjectId: jobId, confirmed: false, sequenceFit: 'log-like' };
    }
    default: {
      // Exhaustiveness guard: if a 13th event is ever added to
      // AuditEventName without updating this switch, this throws loudly
      // instead of silently falling through.
      throw new Error(`serviceAdapter: no subject mapping defined for audit event "${String(eventName)}".`);
    }
  }
}

/**
 * BOTS-6's tenantId is chat_id (docs/adr/0003-chat-is-tenant.md). For the
 * 3 truly platform-level events, falls back to the sentinel. For
 * `audit.policy.changed` specifically, a chat-scoped policy's `scope` *is*
 * the chatId — see "TENANT GAP — RESOLVED" at the top of this file for the
 * `scope === 'global'` convention this assumes.
 */
export function tenantIdFor(record: AuditRecord): string {
  const eventName = record.eventName as AuditEventName;
  if (isChatScopedEvent(eventName)) return chatIdFor(record);
  if (eventName === 'integration.action') {
    // BOTS-9 review finding (HIGH-7): optionally chat-scoped, not
    // mandatorily — unlike isChatScopedEvent's list (which throws when a
    // chatId is missing), most integration.action calls today
    // (storage.put, rabbitmq publish) have no chat context at all and
    // that must keep working exactly as before. A future chat-scoped
    // caller can still opt in by passing chatId to raiseAuditEvent().
    if (record.chatId !== undefined && record.chatId.length > 0) return record.chatId;
    return PLATFORM_TENANT_SENTINEL;
  }
  if (record.eventName === 'audit.policy.changed') {
    const scope = readObservedField(record, 'scope');
    if (typeof scope === 'string' && scope.length > 0 && scope !== 'global') return scope;
  }
  return PLATFORM_TENANT_SENTINEL;
}

/**
 * Bridges `operation` into `metadata.operation`, per Maxim: kept there for
 * filtering/analytics rather than a dedicated column. `severity`,
 * `siteVisible`, and `canBeDisabled` are deliberately *not* included here
 * any more — they're static per-event-type facts, now seeded onto
 * `audit.event_types` instead (see `scripts/seedAuditEventTypes.ts`),
 * not per-occurrence metadata. `source` (module.state.changed's
 * default/override) was never bridged here either — it lives directly in
 * the snapshot data, not metadata.
 *
 * Only usable when the full `AuditRecord` (before/after already resolved)
 * is available *before* building `AuditEventInput` — true for log-like
 * events, not for entity-like ones wired through `mutate` (see the
 * "operation" note at the top of this file).
 */
export function buildMetadataBridge(record: AuditRecord): Record<string, unknown> {
  return { operation: record.operation };
}

/**
 * Builds the `AuditEventInput` half of a `recordEntityChange` call.
 * `idempotencyKey` follows the same `${eventType}:${...identity}` shape
 * BOTS-6 used for `module.state.changed` — see the idempotency-key caveat
 * in the accompanying notes about reused keys silently no-op'ing genuine
 * repeat actions.
 */
/**
 * Deterministic, recursively key-sorted JSON serialization for
 * idempotencyKey construction. NOT the same as
 * `JSON.stringify(value, Object.keys(value).sort())` — that array-replacer
 * trick only whitelists/reorders keys, and it does so *uniformly at every
 * nesting level*, which silently drops any nested key not present in the
 * top-level list: `JSON.stringify({a:{x:1}}, ['a'])` → `{"a":{}}`, the
 * nested `x` vanishes entirely. None of the 12 BOTS-7 event schemas
 * currently nest objects, so that failure mode isn't live today, but it's
 * a real landmine — two different nested payloads could silently collapse
 * to the same idempotencyKey, causing a genuinely new event to be
 * mistaken for a duplicate and dropped. This recurses properly instead.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'; // JSON has no `undefined`; matches JSON.stringify's array-element behavior
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined) // match JSON.stringify: omit undefined-valued object properties
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function idempotencyKeyFor(record: AuditRecord, subject: SubjectMapping, afterFields: Record<string, unknown>): string {
  if (record.idempotencyKey !== undefined && record.idempotencyKey.length > 0) return record.idempotencyKey;
  return `${record.eventName}:${subject.subjectId}:${stableStringify(afterFields)}`;
}

export function toDownstreamInput(record: AuditRecord, registry: AuditEventRegistry = auditEventRegistry): DownstreamAuditEventInput {
  const definition = registry.requireByName(record.eventName);
  const subject = subjectMappingFor(record);
  const afterFields = record.after.status === 'observed' ? record.after.data : {};
  return {
    tenantId: tenantIdFor(record),
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    eventType: record.eventName,
    // BOTS-6 uses a 'v'-prefixed string ('v1'), confirmed in
    // ModuleRegistry.setEnabled() — plain `String(number)` would silently
    // produce a differently-formatted version string.
    eventVersion: `v${record.eventVersion}`,
    category: definition.category,
    source: 'bots7-registry',
    idempotencyKey: idempotencyKeyFor(record, subject, afterFields),
    // `exactOptionalPropertyTypes` in the real repo's tsconfig forbids
    // assigning `undefined` to an optional field directly — these must be
    // omitted entirely, not set to undefined, when there's no value.
    ...(record.actorId !== undefined ? { actorId: record.actorId, actorType: 'telegram_user' } : {}),
    ...(record.chatId !== undefined ? { telegramContext: { chatId: record.chatId } } : {}),
    ...(() => {
      const moduleId = readObservedField(record, 'moduleId');
      return typeof moduleId === 'string' && moduleId.length > 0 ? { moduleId } : {};
    })(),
    metadata: buildMetadataBridge(record),
  };
}

/**
 * Converts BOTS-7's `before`/`after`/`changes` into the shape a
 * `recordEntityChange` `mutate` callback must return.
 *
 * Only safe to use as-is for `sequenceFit === 'log-like'` events (see the
 * ATOMICITY GAP note at the top of this file) — for entity-like events this
 * should inform how you shape the *real* `mutate` callback's return value,
 * not be called after the fact on an already-finished `AuditRecord`.
 */
export function toDownstreamMutationResult(record: AuditRecord): DownstreamAuditMutationResult {
  const before = record.before.status === 'observed' ? record.before.data : undefined;
  const after = record.after.status === 'observed' ? record.after.data : undefined;
  const entitySnapshot = entitySnapshotFor(record, before, after);

  return {
    before,
    after,
    beforeSnapshotStatus: record.before.status,
    afterSnapshotStatus: record.after.status,
    // Per Maxim: store the *full* ChangeSet (status + fields, or status +
    // reason when unavailable) — not just a flattened fields object. The
    // previous version dropped the 'unavailable'/reason case entirely,
    // which quietly lost exactly the kind of "we don't know" signal
    // BOTS-7's whole snapshot-status design exists to preserve.
    changes: record.changes,
    snapshotStatus: entitySnapshot.status,
    snapshotData: entitySnapshot.data,
  };
}

function entitySnapshotFor(
  record: AuditRecord,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): { readonly status: 'current' | 'archived'; readonly data: Record<string, unknown> } {
  if (after !== undefined) return { status: 'current', data: after };
  if (record.after.status === 'not_applicable' && before !== undefined) return { status: 'archived', data: before };
  throw new MissingAuditSnapshotDataError(record.eventName, record.after.status);
}

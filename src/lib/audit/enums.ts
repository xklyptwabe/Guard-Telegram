/**
 * All enums are modelled as string-literal unions (not TS `enum`) to match the
 * project convention already used in `core/contracts.ts` (`ModulePermission`).
 * String literals serialize predictably to JSON/DB and survive refactors
 * without numeric-enum foot-guns.
 */

/** High-level grouping of an event, used for filtering/reporting. */
export type EventCategory =
  | 'module'
  | 'chat'
  | 'audit'
  | 'member'
  | 'bot'
  | 'moderation'
  | 'message'
  | 'command'
  | 'integration';

/** Impact/priority of an event, independent of its category. */
export type EventSeverity = 'debug' | 'info' | 'notice' | 'warning' | 'critical';

/**
 * The effect an action had on the underlying entity. This is supplied by the
 * caller (the module/service raising the event) and drives how before/after
 * are expected to look (see `docs/adr` conventions for operation semantics
 * documented alongside the registry).
 */
export type AuditOperation = 'create' | 'update' | 'delete' | 'soft_delete' | 'noop' | 'failed' | 'unknown';

/**
 * The status of a single snapshot (before or after) when it does not carry
 * observed data. Kept disjoint from "observed" so that "no data" is always
 * explicit and can never be confused with "empty object".
 */
export type SnapshotStatus = 'observed' | 'not_observed' | 'redacted' | 'unknown' | 'not_applicable';

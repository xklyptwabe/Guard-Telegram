import type { AuditOperation, SnapshotStatus } from './enums.js';
import type { Snapshot } from './snapshot.js';

export interface FieldChange<V> {
  readonly before: V | undefined;
  readonly after: V | undefined;
}

/** Reason why a diff could not be computed, e.g. `before_redacted`, `after_unknown`. */
export type ChangesUnavailableReason = `${'before' | 'after'}_${Exclude<SnapshotStatus, 'observed'>}`;

export type ChangeSet<T> =
  | { readonly status: 'computed'; readonly fields: Partial<Record<keyof T, FieldChange<unknown>>> }
  | { readonly status: 'unavailable'; readonly reason: ChangesUnavailableReason };

/**
 * Per-operation rule describing which side of a before/after pair is
 * allowed to legitimately be `not_applicable` — i.e. "this side has no
 * data because that's a normal consequence of this kind of operation", as
 * opposed to a genuine gap (`not_observed`/`redacted`/`unknown`, which are
 * *never* expected regardless of operation).
 *
 * This is the single place the BOTS-7 requirement "реализовать правила
 * create, update, delete, soft delete, noop, failed и unknown" is encoded:
 * every operation's before/after semantics live here, side by side, instead
 * of being scattered `if` branches.
 */
export interface OperationAbsenceRule {
  /** Entity legitimately did not exist yet before this operation. */
  readonly beforeMayBeNotApplicable: boolean;
  /** Entity legitimately does not exist any more after this operation. */
  readonly afterMayBeNotApplicable: boolean;
}

export const OPERATION_ABSENCE_RULES: Readonly<Record<AuditOperation, OperationAbsenceRule>> = {
  // Nothing existed prior to a create — only `after` is expected to exist.
  create: { beforeMayBeNotApplicable: true, afterMayBeNotApplicable: false },
  // A plain update always has the entity present on both sides.
  update: { beforeMayBeNotApplicable: false, afterMayBeNotApplicable: false },
  // A hard delete removes the entity entirely — only `before` is expected.
  delete: { beforeMayBeNotApplicable: false, afterMayBeNotApplicable: true },
  // Soft delete flips a flag (e.g. `deletedAt`) on a row that still exists
  // on both sides — unlike a hard delete, `after` is still expected data,
  // not an absence.
  soft_delete: { beforeMayBeNotApplicable: false, afterMayBeNotApplicable: false },
  // A noop means the operation was attempted but changed nothing: the
  // entity existed (or didn't, symmetrically) identically before and after,
  // so neither side is expected to be absent on its own.
  noop: { beforeMayBeNotApplicable: false, afterMayBeNotApplicable: false },
  // A failed write never reaches persisted state, so there is nothing new
  // to observe as `after`. `before` may also legitimately be absent (e.g. a
  // failed create never had a prior state either).
  failed: { beforeMayBeNotApplicable: true, afterMayBeNotApplicable: true },
  // The caller could not determine what kind of operation this was — make
  // no assumption about which side, if any, is expected to be absent.
  unknown: { beforeMayBeNotApplicable: true, afterMayBeNotApplicable: true },
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const aEntries = Object.entries(a as Record<string, unknown>);
  const bMap = b as Record<string, unknown>;
  if (aEntries.length !== Object.keys(bMap).length) return false;
  return aEntries.every(([key, value]) => deepEqual(value, bMap[key]));
}

/**
 * Resolves a snapshot down to a plain (possibly empty) field map, but *only*
 * when doing so is semantically valid for the given operation:
 *  - `create` legitimately has no "before" fields (nothing existed yet).
 *  - `delete` legitimately has no "after" fields (nothing exists anymore).
 * Any other non-observed status is a genuine gap, never a normal absence.
 */
function resolveSide<T>(
  side: 'before' | 'after',
  snapshot: Snapshot<Partial<T>>,
  operation: AuditOperation,
): { readonly ok: true; readonly fields: Partial<T> } | { readonly ok: false; readonly reason: ChangesUnavailableReason } {
  if (snapshot.status === 'observed') return { ok: true, fields: snapshot.data };
  const rule = OPERATION_ABSENCE_RULES[operation];
  const absenceIsExpected = side === 'before' ? rule.beforeMayBeNotApplicable : rule.afterMayBeNotApplicable;
  if (absenceIsExpected && snapshot.status === 'not_applicable') return { ok: true, fields: {} };
  return { ok: false, reason: `${side}_${snapshot.status}` };
}

/**
 * Computes a field-level diff between two already-validated, already-masked
 * snapshots. This never fabricates data: if either side cannot be resolved
 * (redacted, unknown, not_observed — or a `not_applicable` that the
 * operation doesn't expect), the whole changeset is reported `unavailable`
 * rather than silently diffing against `{}`.
 */
export function computeChanges<T extends Record<string, unknown>>(
  operation: AuditOperation,
  before: Snapshot<Partial<T>>,
  after: Snapshot<Partial<T>>,
): ChangeSet<T> {
  const beforeResult = resolveSide('before', before, operation);
  if (!beforeResult.ok) return { status: 'unavailable', reason: beforeResult.reason };

  const afterResult = resolveSide('after', after, operation);
  if (!afterResult.ok) return { status: 'unavailable', reason: afterResult.reason };

  const keys = new Set<keyof T>([
    ...(Object.keys(beforeResult.fields) as (keyof T)[]),
    ...(Object.keys(afterResult.fields) as (keyof T)[]),
  ]);

  const fields: Partial<Record<keyof T, FieldChange<unknown>>> = {};
  for (const key of keys) {
    const beforeValue = beforeResult.fields[key];
    const afterValue = afterResult.fields[key];
    if (!deepEqual(beforeValue, afterValue)) {
      fields[key] = { before: beforeValue, after: afterValue };
    }
  }
  return { status: 'computed', fields };
}

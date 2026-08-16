import type { AuditRecord } from './types.js';

export interface SafeDownstreamMutationResult {
  readonly before: Record<string, unknown> | undefined;
  readonly after: Record<string, unknown> | undefined;
  readonly beforeSnapshotStatus: AuditRecord['before']['status'];
  readonly afterSnapshotStatus: AuditRecord['after']['status'];
  readonly changes: AuditRecord['changes'];
  readonly snapshotStatus: 'current' | 'archived';
  readonly snapshotData: Record<string, unknown>;
}

/**
 * Like `serviceAdapter.ts`'s `toDownstreamMutationResult`, but never throws
 * `MissingAuditSnapshotDataError`. That function assumes at least one side
 * of the change is real, persistable data — true for every BOTS-7 event
 * *except* the legitimate "we don't know what happened" cases this ticket
 * introduces: a confirmed-`failed` or still-`unknown` external operation,
 * or a deletion of an entity this system never observed in the first
 * place. In all of those, `snapshotStatus` is forced to `archived` (there
 * is no live "current" state to report) and `fallbackSnapshotData` — an
 * explicit, non-fabricated marker, never an empty `{}` — stands in for the
 * entity snapshot only when genuinely neither side carries data.
 */
export function safeDownstreamMutationResult(record: AuditRecord, fallbackSnapshotData: Record<string, unknown>): SafeDownstreamMutationResult {
  const before = record.before.status === 'observed' ? (record.before.data as Record<string, unknown>) : undefined;
  const after = record.after.status === 'observed' ? (record.after.data as Record<string, unknown>) : undefined;
  return {
    before,
    after,
    beforeSnapshotStatus: record.before.status,
    afterSnapshotStatus: record.after.status,
    changes: record.changes,
    snapshotStatus: after !== undefined ? 'current' : 'archived',
    snapshotData: after ?? before ?? fallbackSnapshotData,
  };
}

import { and, eq } from 'drizzle-orm';

import { entitySnapshots } from '../../db/schema/audit.js';
import type { AuditTransaction } from '../auditService.js';

/**
 * Reads back the current `entity_snapshots.snapshot_data` for a subject,
 * for use *inside* a `recordEntityChange` `mutate` callback. The row (if
 * any) was already locked `FOR UPDATE` by `AuditService.recordEntityChange`
 * itself before `mutate` ever runs, so this is a plain read within the same
 * transaction — no separate locking needed here.
 *
 * Returns `undefined` for "never observed before" (either no row exists
 * yet, or its snapshot data is SQL NULL) — callers use that to decide
 * `before: notObserved()` vs `before: observed(...)`.
 */
export async function readCurrentSnapshotData(
  tx: AuditTransaction,
  tenantId: string,
  subjectType: string,
  subjectId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = await tx
    .select({ snapshotData: entitySnapshots.snapshotData })
    .from(entitySnapshots)
    .where(and(eq(entitySnapshots.tenantId, tenantId), eq(entitySnapshots.entityType, subjectType), eq(entitySnapshots.entityId, subjectId)))
    .limit(1);
  const data = rows[0]?.snapshotData as Record<string, unknown> | null | undefined;
  return data ?? undefined;
}

import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../db/client.js';
import { outbox } from '../../db/schema/audit.js';
import { pendingOperations } from '../../db/schema/moderation.js';

export interface AuditOperationalState {
  readonly delivery: {
    readonly pending: number;
    readonly failed: number;
    readonly oldestPendingAgeSeconds: number | null;
  };
  readonly externalOperations: {
    readonly pending: number;
    readonly inProgress: number;
    readonly retryScheduled: number;
    readonly auditPending: number;
    readonly terminalUnknown: number;
    readonly oldestUnfinishedAgeSeconds: number | null;
  };
}

interface CountByStatusRow {
  readonly status: string;
  readonly count: number;
  readonly oldestCreatedAt: Date | string | null;
}

export async function readAuditOperationalState(
  db: DrizzleDatabase,
  now = new Date(),
): Promise<AuditOperationalState> {
  const [deliveryRows, operationRows, auditDebtRows, terminalUnknownRows] = await Promise.all([
    db
      .select({
        status: outbox.status,
        count: sql<number>`count(*)::int`,
        oldestCreatedAt: sql<Date | null>`min(${outbox.createdAt})`,
      })
      .from(outbox)
      .where(inArray(outbox.status, ['pending', 'failed']))
      .groupBy(outbox.status),
    db
      .select({
        status: pendingOperations.status,
        count: sql<number>`count(*)::int`,
        oldestCreatedAt: sql<Date | null>`min(${pendingOperations.createdAt})`,
      })
      .from(pendingOperations)
      .where(
        or(
          eq(pendingOperations.status, 'pending'),
          eq(pendingOperations.status, 'in_progress'),
          and(eq(pendingOperations.status, 'unknown'), isNotNull(pendingOperations.nextAttemptAt)),
        ),
      )
      .groupBy(pendingOperations.status),
    db
      .select({
        count: sql<number>`count(*)::int`,
        oldestCreatedAt: sql<Date | null>`min(${pendingOperations.createdAt})`,
      })
      .from(pendingOperations)
      .where(
        and(
          eq(pendingOperations.auditStatus, 'pending'),
          or(
            inArray(pendingOperations.status, ['succeeded', 'failed']),
            and(eq(pendingOperations.status, 'unknown'), isNull(pendingOperations.nextAttemptAt)),
          ),
        ),
      ),
    db
      .select({
        count: sql<number>`count(*)::int`,
        oldestCreatedAt: sql<Date | null>`min(${pendingOperations.createdAt})`,
      })
      .from(pendingOperations)
      .where(and(eq(pendingOperations.status, 'unknown'), isNull(pendingOperations.nextAttemptAt))),
  ]);

  const deliveryPending = findStatus(deliveryRows, 'pending');
  const operationPending = findStatus(operationRows, 'pending');
  const operationInProgress = findStatus(operationRows, 'in_progress');
  const operationRetryScheduled = findStatus(operationRows, 'unknown');
  const auditDebt = auditDebtRows[0];
  const terminalUnknown = terminalUnknownRows[0];

  return {
    delivery: {
      pending: deliveryPending?.count ?? 0,
      failed: findStatus(deliveryRows, 'failed')?.count ?? 0,
      oldestPendingAgeSeconds: ageSeconds(deliveryPending?.oldestCreatedAt, now),
    },
    externalOperations: {
      pending: operationPending?.count ?? 0,
      inProgress: operationInProgress?.count ?? 0,
      retryScheduled: operationRetryScheduled?.count ?? 0,
      auditPending: auditDebt?.count ?? 0,
      terminalUnknown: terminalUnknown?.count ?? 0,
      oldestUnfinishedAgeSeconds: oldestAgeSeconds(
        [
          operationPending?.oldestCreatedAt,
          operationInProgress?.oldestCreatedAt,
          operationRetryScheduled?.oldestCreatedAt,
          auditDebt?.oldestCreatedAt,
        ],
        now,
      ),
    },
  };
}

function findStatus(rows: readonly CountByStatusRow[], status: string): CountByStatusRow | undefined {
  return rows.find((row) => row.status === status);
}

function oldestAgeSeconds(values: readonly (Date | string | null | undefined)[], now: Date): number | null {
  const timestamps = values
    .map(toTimestamp)
    .filter((value): value is number => value !== undefined);
  if (timestamps.length === 0) return null;
  return Math.max(0, Math.floor((now.getTime() - Math.min(...timestamps)) / 1_000));
}

function ageSeconds(value: Date | string | null | undefined, now: Date): number | null {
  const timestamp = toTimestamp(value);
  return timestamp === undefined ? null : Math.max(0, Math.floor((now.getTime() - timestamp) / 1_000));
}

function toTimestamp(value: Date | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

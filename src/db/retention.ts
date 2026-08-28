import { and, eq, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { CONSUMED_ENVELOPE_RETENTION_DAYS, PROCESSED_UPDATE_RETENTION_DAYS } from '../constants.js';
import type { AuditService } from '../lib/auditService.js';
import { PLATFORM_TENANT_SENTINEL } from '../lib/audit/serviceAdapter.js';
import type { DrizzleDatabase } from './client.js';
import { consumedEnvelopes, processedUpdates } from './schema/core.js';

export async function purgeExpiredProcessedUpdates(database: DrizzleDatabase, retentionDays = PROCESSED_UPDATE_RETENTION_DAYS): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  // BOTS-9 review fix (BLOCKER-5): only `completed` rows are safe to purge —
  // a `received`/`failed`/`processing` row is still owed reprocessing on
  // redelivery; deleting it would re-enable the very at-most-once loss the
  // inbox state machine exists to prevent.
  await database.delete(processedUpdates).where(and(eq(processedUpdates.status, 'completed'), lt(processedUpdates.processedAt, cutoff)));
}

export async function purgeExpiredConsumedEnvelopes(
  database: DrizzleDatabase,
  retentionDays = CONSUMED_ENVELOPE_RETENTION_DAYS,
): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await database.delete(consumedEnvelopes).where(and(eq(consumedEnvelopes.status, 'completed'), lt(consumedEnvelopes.consumedAt, cutoff)));
}

export const AUDIT_RETENTION_DEFAULT_BATCH_SIZE = 500;

export interface AuditRetentionBatchOptions {
  readonly batchSize?: number;
  readonly now?: Date;
}

export interface AuditRetentionBatchResult {
  readonly deletedCount: number;
  readonly deletedEventIds: readonly string[];
  readonly retentionDays: number;
}

export interface AuditRetentionJobOptions extends AuditRetentionBatchOptions {
  readonly jobId?: string;
  readonly idempotencyKey?: string;
}

export interface AuditRetentionJobResult extends AuditRetentionBatchResult {
  readonly jobId: string;
  readonly auditEventId: string;
  readonly duplicate: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export async function purgeExpiredAuditEventsBatch(
  database: Pick<DrizzleDatabase, 'execute'>,
  options: AuditRetentionBatchOptions = {},
): Promise<AuditRetentionBatchResult> {
  const batchSize = options.batchSize ?? AUDIT_RETENTION_DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Audit retention batchSize must be a positive integer.');
  }

  const now = options.now ?? new Date();
  const result = await database.execute<{ id: string; retention_days: number }>(expiredAuditEventsDeleteQuery(now, batchSize));
  const deletedEventIds = result.rows.map((row) => row.id);
  const retentionDays = result.rows.length === 0 ? 0 : Math.min(...result.rows.map((row) => row.retention_days));
  return {
    deletedCount: deletedEventIds.length,
    deletedEventIds,
    retentionDays,
  };
}

export function expiredAuditEventsDeleteQuery(now: Date, batchSize: number) {
  return sql`
    WITH expired AS (
      SELECT
        event."id",
        (event."metadata" #>> '{auditPolicy,values,retentionDays}')::int AS "retention_days"
      FROM "audit"."events" AS event
      WHERE event."metadata" #>> '{auditPolicy,values,retentionDays}' ~ '^[0-9]+$'
        AND event."occurred_at" < ${now}::timestamptz
          - (((event."metadata" #>> '{auditPolicy,values,retentionDays}')::int) * INTERVAL '1 day')
      ORDER BY event."occurred_at" ASC, event."id" ASC
      LIMIT ${batchSize}
    ), purged_delivered_outbox AS (
      DELETE FROM "audit"."outbox" AS box
      USING expired
      WHERE box."event_id" = expired."id"
        AND box."status" = 'delivered'
    )
    DELETE FROM "audit"."events" AS event
    USING expired
    WHERE event."id" = expired."id"
    RETURNING event."id", expired."retention_days"
  `;
}

export async function runAuditRetentionJob(
  audit: AuditService,
  options: AuditRetentionJobOptions = {},
): Promise<AuditRetentionJobResult> {
  const jobId = options.jobId ?? randomUUID();
  const startedAt = options.now ?? new Date();
  let batchResult: AuditRetentionBatchResult | undefined;
  let finishedAt = startedAt;
  const auditResult = await audit.recordEntityChange(
    {
      tenantId: PLATFORM_TENANT_SENTINEL,
      subjectType: 'audit_retention_job',
      subjectId: jobId,
      eventType: 'audit.retention.completed',
      eventVersion: 'v1',
      category: 'audit',
      source: 'audit.retention.job',
      idempotencyKey: options.idempotencyKey ?? `audit.retention.completed:${jobId}`,
      metadata: { operation: 'delete' },
    },
    async (tx) => {
      batchResult = await purgeExpiredAuditEventsBatch(tx, options);
      finishedAt = new Date();
      const snapshot = {
        jobId,
        deletedCount: batchResult.deletedCount,
        retentionDays: batchResult.retentionDays,
        batchSize: options.batchSize ?? AUDIT_RETENTION_DEFAULT_BATCH_SIZE,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      };
      return {
        before: undefined,
        after: snapshot,
        changes: { status: 'completed', deletedEventIds: batchResult.deletedEventIds },
        metadata: { operation: 'delete' },
        snapshotData: snapshot,
      };
    },
  );

  return {
    jobId,
    deletedCount: batchResult?.deletedCount ?? 0,
    deletedEventIds: batchResult?.deletedEventIds ?? [],
    retentionDays: batchResult?.retentionDays ?? 0,
    auditEventId: auditResult.eventId,
    duplicate: auditResult.duplicate,
    startedAt,
    finishedAt,
  };
}

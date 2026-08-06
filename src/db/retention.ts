import { lt, sql } from 'drizzle-orm';

import { PROCESSED_UPDATE_RETENTION_DAYS } from '../constants.js';
import type { DrizzleDatabase } from './client.js';
import { processedUpdates } from './schema/core.js';

export async function purgeExpiredProcessedUpdates(database: DrizzleDatabase, retentionDays = PROCESSED_UPDATE_RETENTION_DAYS): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await database.delete(processedUpdates).where(lt(processedUpdates.processedAt, cutoff));
}

export const AUDIT_RETENTION_DEFAULT_BATCH_SIZE = 500;

export interface AuditRetentionBatchOptions {
  readonly batchSize?: number;
  readonly now?: Date;
}

export interface AuditRetentionBatchResult {
  readonly deletedCount: number;
  readonly deletedEventIds: readonly string[];
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
  const result = await database.execute<{ id: string }>(sql`
    WITH expired AS (
      SELECT event."id"
      FROM "audit"."events" AS event
      WHERE event."metadata" #>> '{auditPolicy,values,retentionDays}' ~ '^[0-9]+$'
        AND event."occurred_at" < ${now}::timestamptz
          - (((event."metadata" #>> '{auditPolicy,values,retentionDays}')::int) * INTERVAL '1 day')
      ORDER BY event."occurred_at" ASC, event."id" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "audit"."events"
    WHERE "id" IN (SELECT "id" FROM expired)
    RETURNING "id"
  `);
  const deletedEventIds = result.rows.map((row) => row.id);
  return { deletedCount: deletedEventIds.length, deletedEventIds };
}

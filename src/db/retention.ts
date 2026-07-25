import { lt } from 'drizzle-orm';

import { PROCESSED_UPDATE_RETENTION_DAYS } from '../constants.js';
import type { DrizzleDatabase } from './client.js';
import { processedUpdates } from './schema/core.js';

export async function purgeExpiredProcessedUpdates(database: DrizzleDatabase, retentionDays = PROCESSED_UPDATE_RETENTION_DAYS): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await database.delete(processedUpdates).where(lt(processedUpdates.processedAt, cutoff));
}

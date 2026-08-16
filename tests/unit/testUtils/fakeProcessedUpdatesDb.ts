import { FakeDrizzleTableDb } from './fakeDrizzleTable.js';

/**
 * In-memory fake of `core.processed_updates` for UpdateInbox unit tests —
 * keyed on `updateId` (the bot+update pair collapses to one row per test
 * since tests exercise a single bot). Rows use the same property names as
 * the drizzle schema's inferred select type.
 */
export function makeProcessedUpdatesColumnKey(processedUpdates: object): Map<unknown, string> {
  const table = processedUpdates as Record<string, unknown>;
  return new Map<unknown, string>([
    [table.botId, 'botId'],
    [table.updateId, 'updateId'],
    [table.status, 'status'],
    [table.attemptCount, 'attemptCount'],
    [table.workerId, 'workerId'],
    [table.leaseExpiresAt, 'leaseExpiresAt'],
    [table.nextAttemptAt, 'nextAttemptAt'],
  ]);
}

export class FakeProcessedUpdatesDb extends FakeDrizzleTableDb {
  public constructor(processedUpdates: object) {
    super(makeProcessedUpdatesColumnKey(processedUpdates), ['botId', 'updateId'], {
      status: 'received',
      attemptCount: 0,
      workerId: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      lastError: null,
      processedAt: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
  }
}

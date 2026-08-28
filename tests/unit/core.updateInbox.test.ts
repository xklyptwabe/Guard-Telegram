import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import { buildDrizzleOrmMock, fakeLogger } from './testUtils/fakePendingOperationsDb.js';
import { FakeProcessedUpdatesDb } from './testUtils/fakeProcessedUpdatesDb.js';

vi.mock('drizzle-orm', async (importOriginal) => buildDrizzleOrmMock(await importOriginal<typeof import('drizzle-orm')>()));

const { processedUpdates } = await import('../../src/db/schema/core.js');
const { UpdateInbox } = await import('../../src/core/updateInbox.js');

function logger(): Logger {
  return fakeLogger() as unknown as Logger;
}

describe('UpdateInbox (BOTS-9 review BLOCKER-5)', () => {
  let db: FakeProcessedUpdatesDb;

  beforeEach(() => {
    db = new FakeProcessedUpdatesDb(processedUpdates);
  });

  function makeInbox(maxAttempts = 5, leaseMs = 45_000): InstanceType<typeof UpdateInbox> {
    return new UpdateInbox(db as never, logger(), maxAttempts, leaseMs);
  }

  it('first delivery is claimed, and complete() makes redelivery dedup (the only case that may skip)', async () => {
    const inbox = makeInbox();
    const first = await inbox.begin('bot-1', '100');
    expect(first.claim).toBe('claimed');
    expect(first.attemptCount).toBe(1);
    await inbox.complete('bot-1', '100');

    expect(db.rows[0]?.status).toBe('completed');
    const redelivery = await inbox.begin('bot-1', '100');
    expect(redelivery.claim).toBe('completed');
  });

  it('THE BLOCKER-5 BUG: a handler failure leaves the row NOT completed — redelivery reprocesses it', async () => {
    const inbox = makeInbox();
    const first = await inbox.begin('bot-1', '101');
    expect(first.claim).toBe('claimed');

    // Handler chain threw: middleware calls fail(), then rethrows.
    await inbox.fail('bot-1', '101', first.attemptCount, new Error('handler exploded'));

    const row = db.rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.workerId).toBeNull(); // claim released for redelivery
    expect(row?.nextAttemptAt).not.toBeNull(); // backoff scheduled
    expect(row?.lastError).toMatchObject({ name: 'Error', message: 'handler exploded' });

    // Under the OLD insert-marker code, redelivery here would skip forever.
    const redelivery = await inbox.begin('bot-1', '101');
    expect(redelivery.claim).toBe('busy'); // backoff window — not yet
    expect(db.rows[0]?.attemptCount).toBe(1);

    // Once the backoff has passed (simulated by rewinding the schedule),
    // redelivery reprocesses.
    db.rows[0]!.nextAttemptAt = new Date(Date.now() - 1);
    const retry = await inbox.begin('bot-1', '101');
    expect(retry.claim).toBe('claimed');
    expect(retry.attemptCount).toBe(2);
  });

  it('a crashed worker (expired processing lease) is reclaimed by redelivery, not skipped', async () => {
    const inbox = makeInbox();
    const first = await inbox.begin('bot-1', '102');
    expect(first.claim).toBe('claimed');
    // Worker died mid-processing: row stays `processing` with its lease.
    expect(db.rows[0]?.status).toBe('processing');

    // Same worker id would find its own live lease... a NEW worker instance
    // is what redelivery after a crash means — but until the lease expires
    // nobody may steal it:
    const other = new UpdateInbox(db as never, logger(), 5, 45_000);
    const duringLease = await other.begin('bot-1', '102');
    expect(duringLease.claim).toBe('busy');

    db.rows[0]!.leaseExpiresAt = new Date(Date.now() - 1); // lease genuinely expired
    const afterLease = await other.begin('bot-1', '102');
    expect(afterLease.claim).toBe('claimed');
    expect(afterLease.attemptCount).toBe(2);
  });

  it('two concurrent claims of the same update: the loser never re-claims (atomic conditional UPDATE)', async () => {
    const a = makeInbox();
    const first = await a.begin('bot-1', '103');
    expect(first.claim).toBe('claimed');

    const b = makeInbox(); // a second process handling the same redelivery
    const second = await b.begin('bot-1', '103');
    expect(second.claim).toBe('busy'); // live lease held by a

    // a's terminal write wins; b's stale attempt is simply not processing.
    await a.complete('bot-1', '103');
    expect(db.rows[0]?.status).toBe('completed');
  });

  it('complete() is a CAS: a worker whose lease was stolen does not clobber the new owner', async () => {
    const a = makeInbox();
    await a.begin('bot-1', '104');

    const b = makeInbox();
    db.rows[0]!.leaseExpiresAt = new Date(Date.now() - 1);
    const stolen = await b.begin('bot-1', '104');
    expect(stolen.claim).toBe('claimed');

    // a finishes late — its completion must be discarded (b owns the row).
    await a.complete('bot-1', '104');
    expect(db.rows[0]?.status).toBe('processing'); // b still owns an in-flight row
    expect(db.rows[0]?.workerId).not.toBeNull();
  });

  it('continues retrying after the backoff cap instead of permanently losing the update', async () => {
    const inbox = makeInbox(2);
    const first = await inbox.begin('bot-1', '105');
    await inbox.fail('bot-1', '105', first.attemptCount, new Error('boom'));
    db.rows[0]!.nextAttemptAt = new Date(Date.now() - 1);

    const second = await inbox.begin('bot-1', '105');
    expect(second.claim).toBe('claimed'); // attempt 2, maxAttempts=2
    await inbox.fail('bot-1', '105', second.attemptCount, new Error('boom again'));
    db.rows[0]!.nextAttemptAt = new Date(Date.now() - 1);

    const third = await inbox.begin('bot-1', '105');
    expect(third.claim).toBe('claimed');
    expect(third.attemptCount).toBe(3);
  });

  it('fail() strips secret-shaped error text before it reaches the database (BLOCKER-4)', async () => {
    const inbox = makeInbox();
    const first = await inbox.begin('bot-1', '106');
    await inbox.fail('bot-1', '106', first.attemptCount, new Error('connect failed: postgres://bot:sup3rs3cret@db.internal:5432/audit'));

    expect(JSON.stringify(db.rows[0]?.lastError)).not.toContain('sup3rs3cret');
    expect(JSON.stringify(db.rows[0]?.lastError)).toContain('[redacted]');
  });

  it('different bots with the same update_id are isolated rows (HIGH-6 scope discipline)', async () => {
    const inbox = makeInbox();
    const forBotA = await inbox.begin('bot-a', '200');
    const forBotB = await inbox.begin('bot-b', '200');
    expect(forBotA.claim).toBe('claimed');
    expect(forBotB.claim).toBe('claimed');
    expect(db.rows).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // BOTS-9 review round-2 (BLOCKER-4): busy reason — webhook transport
  // needs to distinguish "retry later" from "give up"
  // ---------------------------------------------------------------------

  it('round-2: busy with a LIVE lease held elsewhere reports lease_held (webhook must NOT answer 200)', async () => {
    const inbox = makeInbox();
    const other = { claim: undefined, attemptCount: 0 };
    void other;

    // Simulate another worker's active lease: a row claimed with a future lease.
    await inbox.begin('bot-1', '200'); // claim by THIS worker
    db.rows[0]!.workerId = 'other-worker'; // …then the lease belongs to someone else

    const again = await inbox.begin('bot-1', '200');
    expect(again.claim).toBe('busy');
    expect(again.busyReason).toBe('lease_held');
  });

  it('round-2: an update remains claimable after the configured backoff exponent cap', async () => {
    const inbox = makeInbox(2);
    const first = await inbox.begin('bot-1', '201');
    expect(first.claim).toBe('claimed');
    await inbox.fail('bot-1', '201', first.attemptCount, new Error('boom'));
    db.rows[0]!.nextAttemptAt = new Date(0); // backoff elapsed — redelivery is due
    const second = await inbox.begin('bot-1', '201'); // attempt 2
    expect(second.claim).toBe('claimed');
    await inbox.fail('bot-1', '201', second.attemptCount, new Error('boom'));
    db.rows[0]!.nextAttemptAt = new Date(0);
    // The cap limits backoff growth; it must not turn a mandatory update into
    // a permanently skipped tombstone.
    const third = await inbox.begin('bot-1', '201');
    expect(third.claim).toBe('claimed');
    expect(third.attemptCount).toBe(3);
  });

  it('round-2: a row still inside its backoff window reports backoff (webhook answers 409, Telegram redelivers later)', async () => {
    const inbox = makeInbox();
    const first = await inbox.begin('bot-1', '202');
    await inbox.fail('bot-1', '202', first.attemptCount, new Error('boom'));
    // nextAttemptAt is in the future — redelivery arrives too early.
    const early = await inbox.begin('bot-1', '202');
    expect(early.claim).toBe('busy');
    expect(early.busyReason).toBe('backoff');
  });
});

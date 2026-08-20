import { randomUUID } from 'node:crypto';

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { INBOX_LEASE_DURATION_MS, INBOX_MAX_ATTEMPTS, INBOX_RETRY_BASE_DELAY_MS } from '../constants.js';
import type { DrizzleDatabase } from '../db/client.js';
import { processedUpdates } from '../db/schema/core.js';
import { stripForbidden } from '../lib/audit/masking.js';
import type { Logger } from '../lib/logger.js';

/** What {@link UpdateInbox.begin} decided about a delivered update. */
export type InboxClaim =
  | 'claimed'
  /** A previous delivery of this update already fully completed — the dedup case. */
  | 'completed'
  /** Someone else is processing it right now (live lease) or attempts are exhausted — skip, redelivery will retry if allowed. */
  | 'busy';

/** Why a `busy` claim happened — lets the webhook transport decide whether to answer 409 (retry later) or 200 (give up). */
export type InboxBusyReason = 'lease_held' | 'backoff' | 'exhausted';

/**
 * BOTS-9 review finding (BLOCKER-5): replaces the old insert-marker-before-
 * handlers dedup, which turned any post-insert crash or handler exception
 * into a permanently lost update (at-most-once). This is a durable inbox
 * state machine on `core.processed_updates`:
 *
 *   received → processing → completed
 *                  ↘ failed (backoff-scheduled, retried on redelivery)
 *
 * The raw Telegram Update is deliberately NOT stored (BLOCKER-4 forbids
 * persisting raw updates) — so there is no background replay worker and
 * there cannot be one: reprocessing is driven by Telegram's own
 * redelivery, which is exactly the acceptance criterion ("повторная
 * доставка после частичного сбоя"). This class only tracks *whether*
 * processing completed, atomically:
 *
 *  - `begin()` inserts-if-absent then claims via a single conditional
 *    UPDATE (status eligible AND attempts remaining) — two concurrent
 *    deliveries of the same update_id cannot both claim.
 *  - `complete()`/`fail()` are compare-and-swaps on this worker's claim:
 *    if the lease expired and someone else took over, this worker's
 *    terminal write is discarded rather than clobbering the new owner.
 */
export class UpdateInbox {
  private readonly workerId = randomUUID();

  public constructor(
    private readonly db: DrizzleDatabase,
    private readonly logger: Logger,
    private readonly maxAttempts: number = INBOX_MAX_ATTEMPTS,
    private readonly leaseDurationMs: number = INBOX_LEASE_DURATION_MS,
  ) {}

  /**
   * Records the delivery and tries to claim processing for this worker.
   * Returns the claimed row's attempt count so {@link fail} can schedule
   * the retry backoff without a re-read.
   */
  public async begin(botId: string, updateId: string): Promise<{ claim: InboxClaim; attemptCount: number; busyReason?: InboxBusyReason }> {
    await this.db
      .insert(processedUpdates)
      .values({ botId, updateId, status: 'received' })
      .onConflictDoNothing({ target: [processedUpdates.botId, processedUpdates.updateId] });

    const now = new Date();
    const claimed = await this.db
      .update(processedUpdates)
      .set({
        status: 'processing',
        workerId: this.workerId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs),
        attemptCount: sql`${processedUpdates.attemptCount} + 1`,
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(and(eq(processedUpdates.botId, botId), eq(processedUpdates.updateId, updateId), this.eligibility(now), sql`${processedUpdates.attemptCount} < ${this.maxAttempts}`))
      .returning({ attemptCount: processedUpdates.attemptCount });
    if (claimed[0]) return { claim: 'claimed', attemptCount: claimed[0].attemptCount };

    const [row] = await this.db
      .select({ status: processedUpdates.status, attemptCount: processedUpdates.attemptCount, leaseExpiresAt: processedUpdates.leaseExpiresAt })
      .from(processedUpdates)
      .where(and(eq(processedUpdates.botId, botId), eq(processedUpdates.updateId, updateId)))
      .limit(1);
    if (row?.status === 'completed') return { claim: 'completed', attemptCount: row.attemptCount };
    // Round-2 (BLOCKER-4): distinguish WHY the claim failed so the webhook
    // transport can answer 409 (transient — retry later) instead of
    // confirming a 200 for an update that is still owed work.
    const leaseHeld = row?.status === 'processing' && row.leaseExpiresAt !== null && new Date(row.leaseExpiresAt) > now;
    if (leaseHeld) return { claim: 'busy', attemptCount: row?.attemptCount ?? 0, busyReason: 'lease_held' };
    if ((row?.attemptCount ?? 0) >= this.maxAttempts) return { claim: 'busy', attemptCount: row?.attemptCount ?? 0, busyReason: 'exhausted' };
    return { claim: 'busy', attemptCount: row?.attemptCount ?? 0, busyReason: 'backoff' };
  }

  /** Marks the update fully processed — from this moment redelivery dedups instead of reprocessing. */
  public async complete(botId: string, updateId: string): Promise<void> {
    const now = new Date();
    const updated = await this.db
      .update(processedUpdates)
      .set({ status: 'completed', workerId: null, leaseExpiresAt: null, nextAttemptAt: null, processedAt: now, updatedAt: now })
      .where(and(eq(processedUpdates.botId, botId), eq(processedUpdates.updateId, updateId), eq(processedUpdates.workerId, this.workerId), eq(processedUpdates.status, 'processing')))
      .returning({ updateId: processedUpdates.updateId });
    if (updated.length === 0) {
      // Lease was stolen mid-processing (this worker hung past its own
      // lease) — the new owner owns the outcome now; our completion is a
      // no-op for the row. Rare and operationally worth a distinct signal.
      this.logger.warn({ event: 'update.inbox.lease_lost', details: { botId, updateId } });
    }
  }

  /**
   * Records a failed processing attempt and schedules the redelivery
   * window. Does not throw — the original handler error is rethrown by the
   * caller regardless; this only persists the inbox state.
   */
  public async fail(botId: string, updateId: string, attemptCount: number, error: unknown): Promise<void> {
    const now = new Date();
    // Same shape/error hygiene as the moderation outbox: free-text
    // Error.message can embed a DSN/connection string — stripForbidden's
    // value redaction catches that before it reaches the database.
    const errorSummary = stripForbidden({ name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) });
    await this.db
      .update(processedUpdates)
      .set({
        status: 'failed',
        workerId: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(now.getTime() + INBOX_RETRY_BASE_DELAY_MS * 2 ** Math.max(attemptCount - 1, 0)),
        lastError: errorSummary,
        updatedAt: now,
      })
      .where(and(eq(processedUpdates.botId, botId), eq(processedUpdates.updateId, updateId), eq(processedUpdates.workerId, this.workerId)))
      .returning({ updateId: processedUpdates.updateId });
  }

  /** A row is re-claimable when never started, retry-due, or its previous worker's lease has genuinely expired. */
  private eligibility(now: Date) {
    return or(
      eq(processedUpdates.status, 'received'),
      and(eq(processedUpdates.status, 'failed'), or(isNull(processedUpdates.nextAttemptAt), lte(processedUpdates.nextAttemptAt, now))),
      and(eq(processedUpdates.status, 'processing'), or(isNull(processedUpdates.leaseExpiresAt), lte(processedUpdates.leaseExpiresAt, now))),
    );
  }
}

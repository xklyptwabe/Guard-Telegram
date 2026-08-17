import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { GrammyError } from 'grammy';

import {
  PENDING_OPERATION_CALL_TIMEOUT_MS,
  PENDING_OPERATION_LEASE_DURATION_MS,
  PENDING_OPERATION_MAX_ATTEMPTS,
  PENDING_OPERATION_RETRY_BASE_DELAY_MS,
  PENDING_OPERATION_WORKER_POLL_INTERVAL_MS,
} from '../../constants.js';
import type { DrizzleDatabase } from '../../db/client.js';
import { pendingOperations } from '../../db/schema/moderation.js';
import { stripForbidden } from '../audit/masking.js';
import type { Logger } from '../logger.js';

export type PendingOperationStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'unknown';

export interface PendingOperationRow {
  readonly id: string;
  readonly kind: string;
  readonly chatId: string;
  readonly requestPayload: Record<string, unknown>;
  /** Everything needed to reconstruct the audit record once this operation resolves — actor, target, action, reason. Never sent to Telegram. See EnqueueExternalOperationInput.metadata. */
  readonly metadata: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly status: PendingOperationStatus;
  readonly attemptCount: number;
  readonly result: Record<string, unknown> | null;
}

/**
 * The outcome of one *attempt* to perform the external operation.
 *  - `succeeded` / `failed` are always confirmed: Telegram itself answered.
 *  - `unknown` means no confirmed answer arrived (our own timeout, a
 *    network/`HttpError`, or the process was interrupted mid-call) — we
 *    genuinely do not know whether Telegram applied the change.
 */
export interface AttemptOutcome {
  readonly status: 'succeeded' | 'failed' | 'unknown';
  readonly result?: Record<string, unknown>;
}

/**
 * The result of calling {@link PendingOperationsOutbox.execute}.
 * `isFinal` tells the caller whether this is the terminal state for this
 * logical operation (so it's safe to write the one-and-only audit record
 * now) or whether the outbox will keep retrying it in the background — see
 * "ONE FINAL RECORD" below.
 */
export interface PendingOperationResult {
  readonly row: PendingOperationRow;
  readonly outcome: AttemptOutcome;
  readonly isFinal: boolean;
  /** True when a prior call with the same idempotencyKey already resolved this operation (or another worker currently holds/held the lease) — the executor was not invoked, or its result could not be authoritatively recorded by this worker. */
  readonly duplicate: boolean;
}

export type PendingOperationExecutor = (payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

/**
 * BOTS-9 review finding (HIGH-3): writes the one-and-only terminal audit
 * record for an operation. Supplied per `execute()` call and to the worker;
 * must be idempotent (the audit layer's `...:audit` idempotency key makes a
 * repeated call a no-op). A throw means the audit is still owed — the row's
 * `audit_status` stays 'pending' and the worker's backfill pass retries it
 * later, WITHOUT re-invoking the executor.
 */
export type PendingOperationFinalizer = (row: PendingOperationRow, outcome: AttemptOutcome) => Promise<void>;

class OperationTimeoutError extends Error {
  public constructor(ms: number) {
    super(`Operation timed out after ${ms}ms — no confirmed response from Telegram`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * BOTS-9 review finding (BLOCKER-3): the confirmed-vs-unknown
 * classification must not be Telegram-specific — an S3 4xx/5xx *response*
 * is just as confirmed as a GrammyError. Providers whose errors the outbox
 * doesn't natively know (S3 today) wrap their confirmed rejections in this
 * marker class; anything else (network, timeout, library) stays `unknown`.
 */
export class ConfirmedExternalError extends Error {
  public constructor(
    message: string,
    /** Structured, persistence-safe fields for the `failed` result payload (errorCode/description/…). */
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ConfirmedExternalError';
  }
}

export interface EnqueueExternalOperationInput {
  readonly kind: string;
  readonly chatId: string;
  readonly idempotencyKey: string;
  readonly requestPayload: Record<string, unknown>;
  /**
   * Actor/target/action/reason needed to write the eventual audit record —
   * kept separate from requestPayload (which is exactly what's forwarded to
   * Telegram) so it survives a restart: recoverPending() has no live Update
   * or actor on the call stack to ask, only what was written ahead here.
   */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Registry of "how to actually perform operation kind X" — keyed the same
 * way rows are keyed in the DB (`kind`), so a row found by
 * {@link PendingOperationsOutbox.recoverPending} after a restart can be
 * replayed even though the original caller (e.g. a specific
 * `ModerationService.ban()` call) is no longer on the call stack.
 */
export class PendingOperationResolvers {
  private readonly resolvers = new Map<string, PendingOperationExecutor>();

  public register(kind: string, executor: PendingOperationExecutor): void {
    this.resolvers.set(kind, executor);
  }

  public get(kind: string): PendingOperationExecutor | undefined {
    return this.resolvers.get(kind);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function toRow(row: typeof pendingOperations.$inferSelect): PendingOperationRow {
  return {
    id: row.id,
    kind: row.kind,
    chatId: row.chatId,
    requestPayload: row.requestPayload as Record<string, unknown>,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attemptCount: row.attemptCount,
    result: (row.result as Record<string, unknown> | null) ?? null,
  };
}

/**
 * ============================================================================
 * BOTS-9: write-ahead log / outbox for external operations.
 * ============================================================================
 * `execute()` is the write-ahead: the intent to call an external system
 * (currently: the Telegram Bot API for moderation actions) is durably
 * recorded in `moderation.pending_operations` *before* the call happens, so
 * a crash mid-call is recoverable — {@link PendingOperationsOutbox.recoverPending}/
 * {@link PendingOperationsOutbox.startWorker} find it again and retry, per
 * the "outbox продолжает обработку после рестарта" acceptance criterion.
 *
 * LEASE-BASED CLAIMING (BOTS-9 review BLOCKER-2 fix): a row is never acted
 * on just because its `status` column happens to read `in_progress` — every
 * attempt first atomically claims it via `worker_id`/`lease_expires_at`
 * (`FOR UPDATE SKIP LOCKED` for the polling path, a conditional `UPDATE` for
 * a directly-known row). Resolution is a compare-and-swap on `worker_id`:
 * if this worker's lease was reclaimed by someone else before it finished
 * (a hang, a slow network call, a near-crash), its result is discarded
 * rather than silently overwriting whatever the new owner is doing — see
 * `resolve()`/`markUnknownAndMaybeRetry()`.
 *
 * PERSISTENT WORKER (BLOCKER-2): `startWorker()` polls for due work on an
 * interval for as long as the process is up — retries no longer wait for
 * the next full process restart. `recoverPending()` remains a single
 * synchronous sweep (used for the very first pass at boot, before
 * `startWorker()` takes over, and directly by tests).
 *
 * RESIDUAL RISK — LATE COMPLETION: `withTimeout()` races the real Telegram
 * call against our own clock; it does not (cannot, over plain HTTP) cancel
 * the in-flight request. If that request completes *after* we've already
 * given up and moved the row to `unknown`, and a retry then re-issues the
 * same call, the two calls are only safe together if the underlying
 * Telegram operation is itself idempotent — true for ban/unban/restrict
 * (re-applying the same state is a no-op) but NOT proven for delete (a
 * second `deleteMessage` on an already-deleted message returns a confirmed
 * error, which would misreport a delete that actually succeeded as
 * `failed`). Full reconciliation (verifying live Telegram state before a
 * retry) is out of scope here — this is a known, documented gap, not a
 * silently accepted one.
 *
 * ONE FINAL RECORD: the audit event for a moderation action must exist
 * exactly once (`каждая операция создаёт одну итоговую запись`). This class
 * never writes that audit record itself — it only reports whether its
 * outcome is `isFinal`. Callers (e.g. `ModerationService`) must only record
 * the audit event when `isFinal` is true: immediately for a confirmed
 * `succeeded`/`failed`, or once for an `unknown` outcome that has exhausted
 * its retries. An interim `unknown` (retries still remaining) must not be
 * audited — the *next* attempt's outcome is the one that counts.
 */
export class PendingOperationsOutbox {
  /** This process/instance's identity for lease ownership — unique per PendingOperationsOutbox instance (i.e. per process, in normal deployment), never persisted anywhere but this table. */
  private readonly workerId = randomUUID();
  private workerTimer: ReturnType<typeof setTimeout> | undefined;
  private workerStopped = true;

  public constructor(
    private readonly db: DrizzleDatabase,
    private readonly logger: Logger,
    private readonly resolvers: PendingOperationResolvers,
    private readonly maxAttempts: number = PENDING_OPERATION_MAX_ATTEMPTS,
    private readonly callTimeoutMs: number = PENDING_OPERATION_CALL_TIMEOUT_MS,
    private readonly leaseDurationMs: number = PENDING_OPERATION_LEASE_DURATION_MS,
  ) {}

  /**
   * Writes the operation ahead, then attempts it once. If a row for this
   * `idempotencyKey` already reached a terminal state (`succeeded`/`failed`,
   * or `unknown` with retries exhausted), the executor is *not* called
   * again — this is what makes a redelivered Telegram Update (which would
   * naturally produce the same idempotencyKey) safe to replay.
   *
   * `onFinal` (BOTS-9 review HIGH-3) is invoked for every terminal outcome
   * — including one rediscovered as already-terminal on a duplicate call —
   * and must write the terminal audit record; on success the row's
   * `audit_status` flips to 'written'. If it throws, the audit stays owed
   * ('pending') and the worker's backfill pass retries it later without
   * re-invoking the executor.
   */
  public async execute(input: EnqueueExternalOperationInput, executor: PendingOperationExecutor, onFinal?: PendingOperationFinalizer): Promise<PendingOperationResult> {
    const row = await this.writeAhead(input);
    if (row.status === 'succeeded' || row.status === 'failed' || (row.status === 'unknown' && row.attemptCount >= this.maxAttempts)) {
      const outcome: AttemptOutcome = row.result ? { status: row.status, result: row.result } : { status: row.status };
      // The original attempt resolved earlier — possibly with an audit that
      // never got written. A redelivery reaching this branch is exactly the
      // moment to complete that audit (idempotently).
      await this.finalizeAudit(row, outcome, onFinal);
      return { row, outcome, isFinal: true, duplicate: true };
    }
    const result = await this.attemptById(row, executor);
    if (result.isFinal) await this.finalizeAudit(result.row, result.outcome, onFinal);
    return result;
  }

  /**
   * A single synchronous sweep: claims and attempts every row currently due
   * (`pending`, an `unknown` past its backoff, or an `in_progress` whose
   * lease has expired), one at a time, until nothing eligible remains. Used
   * both directly (the very first pass at boot, and by tests) and as the
   * per-tick action of {@link PendingOperationsOutbox.startWorker}.
   *
   * `onFinal` is called for every row that reaches a terminal outcome
   * during this pass — the *only* place a recovered operation's audit
   * record gets written, since there is no live Update/actor on the call
   * stack here to derive one from (see `metadata` on
   * `EnqueueExternalOperationInput`).
   */
  public async recoverPending(onFinal?: PendingOperationFinalizer): Promise<void> {
    for (;;) {
      const claimed = await this.claimNextDue();
      if (!claimed) break; // nothing eligible left this sweep
      const executor = this.resolvers.get(claimed.kind);
      if (!executor) {
        // Claimed but nothing knows how to run it — release the claim
        // immediately (rather than holding a lease for no reason) so it's
        // still visible/reclaimable, and move on. Self-healing once a
        // resolver for this `kind` is registered (e.g. after a deploy).
        await this.releaseClaim(claimed.id);
        this.logger.warn({ event: 'pending_operations.recover.no_resolver', details: { kind: claimed.kind, id: claimed.id } });
        continue;
      }
      this.logger.info({ event: 'pending_operations.recover.resuming', details: { kind: claimed.kind, id: claimed.id } });
      const result = await this.runClaimed(claimed, executor);
      if (result.isFinal) await this.finalizeAudit(result.row, result.outcome, onFinal);
    }
    // BOTS-9 review finding (HIGH-3): a terminal operation whose audit write
    // failed used to be silently incomplete forever. Terminal rows with
    // `audit_status='pending'` are backfilled here — audit only, never a
    // re-run of the executor.
    await this.backfillPendingAudits(onFinal);
  }

  /**
   * Starts polling for due work every `pollIntervalMs` for as long as the
   * process stays up (BOTS-9 review BLOCKER-2: previously retries only
   * ever happened once, at bootstrap). Safe to call once per instance; a
   * second call while already running is a no-op. Call
   * {@link PendingOperationsOutbox.stopWorker} during graceful shutdown.
   */
  public startWorker(onFinal?: PendingOperationFinalizer, pollIntervalMs: number = PENDING_OPERATION_WORKER_POLL_INTERVAL_MS): void {
    if (!this.workerStopped) return;
    this.workerStopped = false;
    const tick = (): void => {
      if (this.workerStopped) return;
      this.recoverPending(onFinal)
        .catch((error: unknown) => {
          this.logger.error({ event: 'pending_operations.worker.tick_failed', error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
        })
        .finally(() => {
          if (!this.workerStopped) this.workerTimer = setTimeout(tick, pollIntervalMs);
        });
    };
    tick();
  }

  /** Stops the polling loop started by {@link PendingOperationsOutbox.startWorker}. Does not cancel an attempt already in flight — that attempt still resolves (or times out) normally; it just won't be followed by another tick. */
  public stopWorker(): void {
    this.workerStopped = true;
    if (this.workerTimer) {
      clearTimeout(this.workerTimer);
      this.workerTimer = undefined;
    }
  }

  private async writeAhead(input: EnqueueExternalOperationInput): Promise<PendingOperationRow> {
    const existing = await this.db
      .select()
      .from(pendingOperations)
      .where(eq(pendingOperations.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing[0]) return toRow(existing[0]);

    const inserted = await this.db
      .insert(pendingOperations)
      .values({
        kind: input.kind,
        chatId: input.chatId,
        idempotencyKey: input.idempotencyKey,
        requestPayload: stripForbidden(input.requestPayload),
        metadata: input.metadata ? stripForbidden(input.metadata) : {},
        status: 'pending',
      })
      .onConflictDoNothing({ target: pendingOperations.idempotencyKey })
      .returning();
    if (inserted[0]) return toRow(inserted[0]);

    // Lost the insert race to a concurrent caller — read back what they wrote.
    const [row] = await this.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, input.idempotencyKey)).limit(1);
    if (!row) throw new Error(`PendingOperationsOutbox: failed to write ahead operation "${input.idempotencyKey}"`);
    return toRow(row);
  }

  /** Eligibility shared by both claim paths: `pending` outright; an `unknown` only once its backoff elapsed AND attempts remain; an `in_progress` only once its lease has expired (or, for pre-lease rows, was never set). An *exhausted* `unknown` (`next_attempt_at` null) is deliberately NOT claimable — see the class doc's LATE COMPLETION note: never blindly re-run a possibly non-idempotent call that already timed out. */
  private eligibilityCondition(now: Date) {
    return or(
      eq(pendingOperations.status, 'pending'),
      and(
        eq(pendingOperations.status, 'unknown'),
        isNotNull(pendingOperations.nextAttemptAt),
        lte(pendingOperations.nextAttemptAt, now),
        sql`${pendingOperations.attemptCount} < ${this.maxAttempts}`,
      ),
      and(eq(pendingOperations.status, 'in_progress'), or(isNull(pendingOperations.leaseExpiresAt), lte(pendingOperations.leaseExpiresAt, now))),
    );
  }

  /**
   * Claims one *specific* row by id — used by `execute()`, which already
   * knows exactly which row it just wrote ahead (or found by
   * idempotencyKey). A single targeted `UPDATE ... WHERE id = $1 AND
   * <eligible>` is already atomic under Postgres's own row-level locking;
   * no `SKIP LOCKED` needed for a single specific id.
   */
  private async claimById(id: string): Promise<PendingOperationRow | undefined> {
    const now = new Date();
    const claimed = await this.db
      .update(pendingOperations)
      .set({ status: 'in_progress', workerId: this.workerId, leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs), attemptCount: sql`${pendingOperations.attemptCount} + 1`, lastAttemptAt: now, updatedAt: now })
      .where(and(eq(pendingOperations.id, id), this.eligibilityCondition(now)))
      .returning();
    return claimed[0] ? toRow(claimed[0]) : undefined;
  }

  /**
   * Claims the next due row across the whole table — used by the polling
   * worker / `recoverPending()`, where "which row" isn't known ahead of
   * time. `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction is the
   * standard atomic-work-queue pattern: concurrent callers (multiple
   * workers, or a worker racing a fresh `execute()` call) never block on
   * or double-claim the same row — a locked-by-someone-else row is simply
   * skipped, not waited for.
   */
  private async claimNextDue(): Promise<PendingOperationRow | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const candidates = await tx
        .select({ id: pendingOperations.id })
        .from(pendingOperations)
        .where(this.eligibilityCondition(now))
        .orderBy(pendingOperations.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      const candidateId = candidates[0]?.id;
      if (!candidateId) return undefined;

      const claimed = await tx
        .update(pendingOperations)
        .set({ status: 'in_progress', workerId: this.workerId, leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs), attemptCount: sql`${pendingOperations.attemptCount} + 1`, lastAttemptAt: now, updatedAt: now })
        .where(eq(pendingOperations.id, candidateId))
        .returning();
      return claimed[0] ? toRow(claimed[0]) : undefined;
    });
  }

  /**
   * Gives up a claim without resolving it (no eligible resolver). The row
   * stays `in_progress` with a *fresh* lease rather than a null one — a
   * null lease would make it instantly re-claimable, and since claiming is
   * what discovered there is no resolver, the same sweep would pick it up
   * again forever (claim → no resolver → release → claim → …). A fresh
   * lease bounds the retry to the worker's next ticks after
   * `leaseDurationMs`: still self-healing once a resolver for this `kind`
   * ships (e.g. after a deploy), just not in a tight loop.
   */
  private async releaseClaim(id: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(pendingOperations)
      .set({ workerId: null, leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs), updatedAt: now })
      .where(and(eq(pendingOperations.id, id), eq(pendingOperations.workerId, this.workerId)));
  }

  private async attemptById(row: PendingOperationRow, executor: PendingOperationExecutor): Promise<PendingOperationResult> {
    const claimed = await this.claimById(row.id);
    if (!claimed) {
      // Lost the claim — someone else (a concurrent call, or the polling
      // worker) already holds this row's lease right now.
      return { row, outcome: { status: 'unknown' }, isFinal: false, duplicate: true };
    }
    return this.runClaimed(claimed, executor);
  }

  private async runClaimed(claimed: PendingOperationRow, executor: PendingOperationExecutor): Promise<PendingOperationResult> {
    try {
      const result = await withTimeout(executor(claimed.requestPayload), this.callTimeoutMs);
      const resultPayload = result ? stripForbidden(result) : {};
      const resolved = await this.resolve(claimed.id, 'succeeded', resultPayload);
      if (!resolved) return this.orphanedResult(claimed, { status: 'succeeded', result: resultPayload });
      this.logger.info({ event: 'pending_operations.attempt.succeeded', details: { kind: claimed.kind, id: claimed.id } });
      return { row: { ...claimed, status: 'succeeded', result: resultPayload }, outcome: { status: 'succeeded', result: resultPayload }, isFinal: true, duplicate: false };
    } catch (error: unknown) {
      if (error instanceof GrammyError || error instanceof ConfirmedExternalError) {
        // CONFIRMED — the external system itself answered with an error.
        // Terminal: retrying an authoritative rejection (e.g. missing admin
        // rights) would just fail again. `description` is the provider's
        // own text, not user-supplied — low risk, but stripForbidden runs
        // uniformly on every persisted value regardless of source
        // (defense-in-depth, BOTS-9 review BLOCKER-4).
        const partialOutcome = (error as unknown as Record<string, unknown>).partialOutcome;
        const result: Record<string, unknown> = error instanceof GrammyError ? { errorCode: error.error_code, description: error.description } : { ...error.details, description: error.message };
        const confirmed = stripForbidden({ ...result, ...(partialOutcome !== undefined ? { partialOutcome } : {}) });
        const resolved = await this.resolve(claimed.id, 'failed', confirmed);
        if (!resolved) return this.orphanedResult(claimed, { status: 'failed', result: confirmed });
        this.logger.warn({ event: 'pending_operations.attempt.failed', details: { kind: claimed.kind, id: claimed.id, ...confirmed } });
        return { row: { ...claimed, status: 'failed', result: confirmed }, outcome: { status: 'failed', result: confirmed }, isFinal: true, duplicate: false };
      }
      // UNCONFIRMED — timeout, network error, or any other non-Telegram
      // failure. We do not know whether Telegram applied the change.
      return this.markUnknownAndMaybeRetry(claimed, error);
    }
  }

  /** A CAS on resolve() failed: this worker's lease was reclaimed by someone else before it could report its own result — see the class doc's "LATE COMPLETION" note. Logged distinctly because it's a rare, operationally important signal, and reported as non-final/duplicate so the caller never writes an audit record for an outcome this worker no longer has authority over. */
  private orphanedResult(row: PendingOperationRow, attempted: AttemptOutcome): PendingOperationResult {
    this.logger.error({ event: 'pending_operations.attempt.lease_lost', details: { kind: row.kind, id: row.id, attemptedStatus: attempted.status } });
    return { row, outcome: { status: 'unknown' }, isFinal: false, duplicate: true };
  }

  private async markUnknownAndMaybeRetry(row: PendingOperationRow, error: unknown): Promise<PendingOperationResult> {
    const attemptCount = row.attemptCount;
    const exhausted = attemptCount >= this.maxAttempts;
    const nextAttemptAt = exhausted ? null : new Date(Date.now() + PENDING_OPERATION_RETRY_BASE_DELAY_MS * 2 ** (attemptCount - 1));
    // BOTS-9 review finding (BLOCKER-4): a raw Error.message is
    // unstructured free text from wherever the failure originated — a
    // driver-level connection error can legitimately embed a DSN/connection
    // string. stripForbidden's value-redaction (see masking.ts) catches
    // exactly this shape before it ever reaches the database or the logs.
    const errorSummary = stripForbidden({ name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) });
    const resolved = await this.db
      .update(pendingOperations)
      .set({ status: 'unknown', nextAttemptAt, result: errorSummary, workerId: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(pendingOperations.id, row.id), eq(pendingOperations.workerId, this.workerId)))
      .returning();
    if (resolved.length === 0) return this.orphanedResult(row, { status: 'unknown', result: errorSummary });
    this.logger.warn({
      event: exhausted ? 'pending_operations.attempt.unknown_exhausted' : 'pending_operations.attempt.unknown_will_retry',
      details: { kind: row.kind, id: row.id, attemptCount, ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}) },
      error: errorSummary,
    });
    return {
      row: { ...row, status: 'unknown', result: errorSummary },
      outcome: { status: 'unknown', result: errorSummary },
      isFinal: exhausted,
      duplicate: false,
    };
  }

  /** CAS finalization: only succeeds if this worker still owns the lease (`worker_id` still matches) — see the class doc's "LEASE-BASED CLAIMING" note. Returns false, never throws, when the CAS loses; the caller decides what that means (see `orphanedResult`). */
  private async resolve(id: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<boolean> {
    const updated = await this.db
      .update(pendingOperations)
      .set({ status, result, nextAttemptAt: null, workerId: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(pendingOperations.id, id), eq(pendingOperations.workerId, this.workerId)))
      .returning({ id: pendingOperations.id });
    return updated.length > 0;
  }

  /**
   * Runs the terminal audit finalizer and, on success, durably records that
   * the audit is no longer owed (BOTS-9 review HIGH-3). Never throws — a
   * finalizer failure is logged as an error and leaves `audit_status` at
   * 'pending' for the worker's backfill pass. Returns whether the audit got
   * written.
   */
  private async finalizeAudit(row: PendingOperationRow, outcome: AttemptOutcome, onFinal: PendingOperationFinalizer | undefined): Promise<boolean> {
    if (!onFinal) return false;
    try {
      await onFinal(row, outcome);
      await this.markAuditWritten(row.id);
      return true;
    } catch (error: unknown) {
      this.logger.error({
        event: 'pending_operations.audit.finalization_failed',
        details: { kind: row.kind, id: row.id, outcomeStatus: outcome.status },
        error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
      });
      return false;
    }
  }

  private async markAuditWritten(id: string): Promise<void> {
    await this.db
      .update(pendingOperations)
      .set({ auditStatus: 'written', auditWorkerId: null, auditLeaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(pendingOperations.id, id), eq(pendingOperations.auditStatus, 'pending')));
  }

  /** A row is terminal for audit purposes once the operation itself resolved: confirmed `succeeded`/`failed`, or an `unknown` that exhausted its retries (no next attempt scheduled). */
  private terminalForAudit() {
    return or(inArray(pendingOperations.status, ['succeeded', 'failed']), and(eq(pendingOperations.status, 'unknown'), isNull(pendingOperations.nextAttemptAt)));
  }

  /**
   * Retries owed-but-unwritten terminal audits. Claims via a dedicated
   * `audit_worker_id` lease (separate from the operation's own lease, so
   * backfilling a terminal row never looks like an operation retry), then
   * invokes the finalizer — idempotent at the audit layer via the
   * `...:audit` idempotency key. Stops this pass on the first finalizer
   * failure (the next worker tick retries — no tight failure loop).
   */
  private async backfillPendingAudits(onFinal: PendingOperationFinalizer | undefined): Promise<void> {
    for (;;) {
      const claimed = await this.claimAuditPending();
      if (!claimed) return;
      if (!onFinal) {
        await this.releaseAuditClaim(claimed.id);
        this.logger.warn({ event: 'pending_operations.audit.backfill_no_finalizer', details: { kind: claimed.kind, id: claimed.id } });
        return;
      }
      const outcome: AttemptOutcome = claimed.result ? { status: claimed.status as AttemptOutcome['status'], result: claimed.result } : { status: claimed.status as AttemptOutcome['status'] };
      const written = await this.finalizeAudit(claimed, outcome, onFinal);
      if (!written) {
        await this.releaseAuditClaim(claimed.id);
        return;
      }
    }
  }

  private async claimAuditPending(): Promise<PendingOperationRow | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const candidates = await tx
        .select({ id: pendingOperations.id })
        .from(pendingOperations)
        .where(and(this.terminalForAudit(), eq(pendingOperations.auditStatus, 'pending'), or(isNull(pendingOperations.auditWorkerId), lte(pendingOperations.auditLeaseExpiresAt, now))))
        .orderBy(pendingOperations.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      const candidateId = candidates[0]?.id;
      if (!candidateId) return undefined;
      const claimed = await tx
        .update(pendingOperations)
        .set({ auditWorkerId: this.workerId, auditLeaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs), updatedAt: now })
        .where(eq(pendingOperations.id, candidateId))
        .returning();
      return claimed[0] ? toRow(claimed[0]) : undefined;
    });
  }

  private async releaseAuditClaim(id: string): Promise<void> {
    await this.db.update(pendingOperations).set({ auditWorkerId: null, auditLeaseExpiresAt: null, updatedAt: new Date() }).where(and(eq(pendingOperations.id, id), eq(pendingOperations.auditWorkerId, this.workerId)));
  }
}

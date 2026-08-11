import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { GrammyError } from 'grammy';

import {
  PENDING_OPERATION_CALL_TIMEOUT_MS,
  PENDING_OPERATION_MAX_ATTEMPTS,
  PENDING_OPERATION_RETRY_BASE_DELAY_MS,
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
  /** True when a prior call with the same idempotencyKey already resolved this operation — the executor was not invoked again. */
  readonly duplicate: boolean;
}

export type PendingOperationExecutor = (payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

class OperationTimeoutError extends Error {
  public constructor(ms: number) {
    super(`Operation timed out after ${ms}ms — no confirmed response from Telegram`);
    this.name = 'OperationTimeoutError';
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
 * a crash mid-call is recoverable — {@link recoverPending} finds it again on
 * the next startup and retries, per the "outbox продолжает обработку после
 * рестарта" acceptance criterion.
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
  public constructor(
    private readonly db: DrizzleDatabase,
    private readonly logger: Logger,
    private readonly resolvers: PendingOperationResolvers,
    private readonly maxAttempts: number = PENDING_OPERATION_MAX_ATTEMPTS,
    private readonly callTimeoutMs: number = PENDING_OPERATION_CALL_TIMEOUT_MS,
  ) {}

  /**
   * Writes the operation ahead, then attempts it once. If a row for this
   * `idempotencyKey` already reached a terminal state (`succeeded`/`failed`,
   * or `unknown` with retries exhausted), the executor is *not* called
   * again — this is what makes a redelivered Telegram Update (which would
   * naturally produce the same idempotencyKey) safe to replay.
   */
  public async execute(input: EnqueueExternalOperationInput, executor: PendingOperationExecutor): Promise<PendingOperationResult> {
    const row = await this.writeAhead(input);
    if (row.status === 'succeeded' || row.status === 'failed' || (row.status === 'unknown' && row.attemptCount >= this.maxAttempts)) {
      const outcome: AttemptOutcome = row.result ? { status: row.status, result: row.result } : { status: row.status };
      return { row, outcome, isFinal: true, duplicate: true };
    }
    if (row.status === 'in_progress') {
      // Another concurrent call (or the recovery loop) already claimed this
      // row — never dispatch the same external call twice concurrently.
      return { row, outcome: { status: 'unknown' }, isFinal: false, duplicate: true };
    }
    return this.attempt(row, executor);
  }

  /**
   * On startup, resumes any operation that was interrupted mid-flight
   * (`in_progress` when the process died) or left `unknown` with retries
   * remaining and due for another attempt. Requires a resolver to be
   * registered for the row's `kind` — an unresolvable `kind` is logged and
   * left untouched rather than silently dropped.
   *
   * `onFinal` is called for every row that reaches a terminal outcome
   * during this pass — this is the *only* place a recovered operation's
   * audit record gets written, since there is no live Update/actor on the
   * call stack here to derive one from (see `metadata` on
   * `EnqueueExternalOperationInput`).
   */
  public async recoverPending(onFinal?: (row: PendingOperationRow, outcome: AttemptOutcome) => Promise<void>): Promise<void> {
    const now = new Date();
    const rows = await this.db
      .select()
      .from(pendingOperations)
      .where(
        or(
          inArray(pendingOperations.status, ['pending', 'in_progress']),
          and(eq(pendingOperations.status, 'unknown'), lte(pendingOperations.nextAttemptAt, now)),
        ),
      );
    for (const raw of rows) {
      const row = toRow(raw);
      if (row.status === 'unknown' && row.attemptCount >= this.maxAttempts) continue;
      const executor = this.resolvers.get(row.kind);
      if (!executor) {
        this.logger.warn({ event: 'pending_operations.recover.no_resolver', details: { kind: row.kind, id: row.id } });
        continue;
      }
      this.logger.info({ event: 'pending_operations.recover.resuming', details: { kind: row.kind, id: row.id, previousStatus: row.status } });
      const result = await this.attempt(row, executor);
      if (result.isFinal && onFinal) await onFinal(result.row, result.outcome);
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

  /** Atomically claims a `pending`/`unknown` row for this attempt — never lets two concurrent callers dispatch the same external call. */
  private async claim(id: string): Promise<PendingOperationRow | undefined> {
    const now = new Date();
    const claimed = await this.db
      .update(pendingOperations)
      .set({ status: 'in_progress', attemptCount: sql`${pendingOperations.attemptCount} + 1`, lastAttemptAt: now, updatedAt: now })
      .where(and(eq(pendingOperations.id, id), inArray(pendingOperations.status, ['pending', 'unknown'])))
      .returning();
    return claimed[0] ? toRow(claimed[0]) : undefined;
  }

  private async attempt(row: PendingOperationRow, executor: PendingOperationExecutor): Promise<PendingOperationResult> {
    const claimed = row.status === 'in_progress' ? row : await this.claim(row.id);
    if (!claimed) {
      // Lost the claim race — someone else (another request, or a
      // concurrent recovery pass) is handling this row right now.
      return { row, outcome: { status: 'unknown' }, isFinal: false, duplicate: true };
    }

    try {
      const result = await withTimeout(executor(claimed.requestPayload), this.callTimeoutMs);
      const resultPayload = result ? stripForbidden(result) : {};
      await this.resolve(claimed.id, 'succeeded', resultPayload);
      this.logger.info({ event: 'pending_operations.attempt.succeeded', details: { kind: claimed.kind, id: claimed.id } });
      return { row: { ...claimed, status: 'succeeded', result: resultPayload }, outcome: { status: 'succeeded', result: resultPayload }, isFinal: true, duplicate: false };
    } catch (error: unknown) {
      if (error instanceof GrammyError) {
        // CONFIRMED — Telegram itself answered with an error. Terminal:
        // retrying an authoritative rejection (e.g. missing admin rights)
        // would just fail again.
        const result = { errorCode: error.error_code, description: error.description };
        await this.resolve(claimed.id, 'failed', result);
        this.logger.warn({ event: 'pending_operations.attempt.failed', details: { kind: claimed.kind, id: claimed.id, ...result } });
        return { row: { ...claimed, status: 'failed', result }, outcome: { status: 'failed', result }, isFinal: true, duplicate: false };
      }
      // UNCONFIRMED — timeout, network error, or any other non-Telegram
      // failure. We do not know whether Telegram applied the change.
      return this.markUnknownAndMaybeRetry(claimed, error);
    }
  }

  private async markUnknownAndMaybeRetry(row: PendingOperationRow, error: unknown): Promise<PendingOperationResult> {
    const attemptCount = row.attemptCount;
    const exhausted = attemptCount >= this.maxAttempts;
    const nextAttemptAt = exhausted ? null : new Date(Date.now() + PENDING_OPERATION_RETRY_BASE_DELAY_MS * 2 ** (attemptCount - 1));
    const errorSummary = { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) };
    await this.db
      .update(pendingOperations)
      .set({ status: 'unknown', nextAttemptAt, result: errorSummary, updatedAt: new Date() })
      .where(eq(pendingOperations.id, row.id));
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

  private async resolve(id: string, status: 'succeeded' | 'failed', result: Record<string, unknown>): Promise<void> {
    await this.db.update(pendingOperations).set({ status, result, nextAttemptAt: null, updatedAt: new Date() }).where(eq(pendingOperations.id, id));
  }
}

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
  /** Policy-projected audit metadata. Never used as the source of required recovery identity. */
  readonly metadata: Record<string, unknown>;
  /** Minimal operational identity required to finalize the audit after a restart. Never sent to Telegram or filtered by an audit display policy. */
  readonly recoveryMetadata: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly status: PendingOperationStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly result: Record<string, unknown> | null;
  /** 'pending' | 'written' | 'policy_skipped' — see the schema column doc. */
  readonly auditStatus: string;
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
  /**
   * BOTS-9 review round-2 (BLOCKER-1/BLOCKER-4): true when the terminal
   * audit is durably done (`recorded`/`policy_skipped`, or the row was
   * already marked written/skipped before — the retention-tombstone case),
   * or when no audit is owed yet (non-final outcome). False ONLY when this
   * outcome is terminal AND the audit is still owed but could not be
   * finalized — the caller (e.g. `ModerationService`) must then treat the
   * operation as incomplete so the update chain retries until the audit
   * lands.
   */
  readonly auditFinalized: boolean;
}

export type PendingOperationExecutor = (payload: Record<string, unknown>) => Promise<Record<string, unknown> | void>;

/**
 * BOTS-9 review finding (HIGH-3): writes the one-and-only terminal audit
 * record for an operation. Supplied per `execute()` call and to the worker;
 * must be idempotent (the audit layer's `...:audit` idempotency key makes a
 * repeated call a no-op).
 *
 * BOTS-9 review round-2 (BLOCKER-1): the contract now has an explicit
 * result instead of `Promise<void>`:
 *
 *   - `{ status: 'recorded' }`       → event durably written → outbox marks
 *                                      `audit_status='written'`
 *   - `{ status: 'policy_skipped' }` → a *deliberate* policy decision (the
 *                                      resolved audit policy disabled the
 *                                      event) → outbox marks
 *                                      `audit_status='policy_skipped'`, no
 *                                      record owed, backfill stops retrying
 *   - throw                          → infrastructure failure → audit is
 *                                      still owed: `audit_status` stays
 *                                      'pending' and the worker's backfill
 *                                      pass retries it later WITHOUT
 *                                      re-invoking the executor.
 *
 * A swallowed error (finalizer returning normally without recording) is now
 * impossible by construction: returning anything other than the two legal
 * statuses is a type error, and `markAuditWritten()` is only ever called
 * after a `recorded` result.
 */
export type PendingOperationFinalizer = (
  row: PendingOperationRow,
  outcome: AttemptOutcome,
) => Promise<{ readonly status: 'recorded' } | { readonly status: 'policy_skipped' }>;

/** How {@link PendingOperationsOutbox.finalizeAudit} resolved for a row. */
export type AuditFinalizeStatus = 'recorded' | 'policy_skipped' | 'failed';

class OperationTimeoutError extends Error {
  public constructor(ms: number) {
    super(`Operation timed out after ${ms}ms — no confirmed response from Telegram`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * BOTS-9 review round-2 (BLOCKER-4): base class for "the side effect is
 * done but its MANDATORY audit record is still owed". The update-processing
 * chain (`CommandDispatcher`) lets any subclass propagate so the durable
 * inbox does not complete the update — Telegram redelivers, the operation
 * is found terminal, and the duplicate branch finishes the audit
 * idempotently.
 */
export class AuditFinalizationPendingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuditFinalizationPendingError';
  }
}

export function isAuditPendingError(error: unknown): boolean {
  if (error instanceof AuditFinalizationPendingError) return true;
  return error instanceof Error && (error.name === 'AuditFinalizationPendingError' || error.name.endsWith('AuditPendingError'));
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
  readonly auditEvent?: PendingOperationAuditEventContext;
  /** Optional audit data, projected through the effective policy before persistence. */
  readonly metadata?: Record<string, unknown>;
  /**
   * Minimal immutable identity needed to reconstruct the eventual audit
   * record after a restart. Keep optional descriptive data in `metadata`;
   * this envelope bypasses display-policy projection and is only protected
   * by the forbidden-data filter.
   */
  readonly recoveryMetadata?: PendingOperationRecoveryMetadata;
}

export interface PendingOperationRecoveryMetadata {
  readonly action?: string;
  readonly actorUserId?: string;
  readonly targetUserId?: string;
  readonly integrationId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly moduleId?: string;
  readonly durationMs?: number;
  readonly success?: boolean;
}

export interface PendingOperationAuditEventContext {
  readonly eventType: string;
  readonly eventVersion: string;
  readonly moduleId?: string;
}

export type PendingOperationMetadataSanitizer = (input: {
  readonly kind: string;
  readonly chatId: string;
  readonly idempotencyKey: string;
  readonly auditEvent: PendingOperationAuditEventContext;
  readonly metadata: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

/**
 * Registry of "how to actually perform operation kind X" — keyed the same
 * way rows are keyed in the DB (`kind`), so a row found by
 * {@link PendingOperationsOutbox.recoverPending} after a restart can be
 * replayed even though the original caller (e.g. a specific
 * `ModerationService.ban()` call) is no longer on the call stack.
 *
 * Each kind also declares its retry-after-unknown policy
 * (`retryAfterUnknown`). BLOCKER-2 (round-2): a non-idempotent destructive
 * call like `telegram.deleteMessage` must NEVER be blindly re-issued after
 * an unconfirmed `unknown` outcome — the first request may have landed, and
 * re-issuing it would turn a success into a confirmed failure ("message
 * already deleted"). Kinds default to `retryAfterUnknown: true` (safe for
 * idempotent calls: ban/unban/restrict re-apply the same state as a no-op,
 * `rabbitmq.publish` republishes the SAME envelope id, S3 recovery only
 * ever re-runs a read-only HEAD).
 */
export interface PendingOperationResolver {
  readonly executor: PendingOperationExecutor;
  readonly retryAfterUnknown: boolean;
}

interface ClaimedPendingOperation {
  readonly row: PendingOperationRow;
  readonly interruptedNonRetryable: boolean;
}

const interruptedOperationResult = { reason: 'worker_lease_expired' } as const;

export class PendingOperationResolvers {
  private readonly resolvers = new Map<string, PendingOperationResolver>();

  public register(kind: string, executor: PendingOperationExecutor, options: { readonly retryAfterUnknown?: boolean } = {}): void {
    this.resolvers.set(kind, { executor, retryAfterUnknown: options.retryAfterUnknown ?? true });
  }

  public get(kind: string): PendingOperationExecutor | undefined {
    return this.resolvers.get(kind)?.executor;
  }

  /** Whether an `unknown` outcome for this kind may schedule a blind retry. Unknown kinds default to safe (true) for forward compatibility. */
  public retryAfterUnknown(kind: string): boolean {
    return this.resolvers.get(kind)?.retryAfterUnknown ?? false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const pendingOperationMetadataFormatVersion = 1;
const pendingOperationRecoveryMetadataStringFields = ['action', 'actorUserId', 'targetUserId', 'integrationId', 'targetType', 'targetId', 'moduleId'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeStoredMetadata(value: unknown): { readonly metadata: Record<string, unknown>; readonly recoveryMetadata: Record<string, unknown> } {
  if (
    isRecord(value) &&
    value.formatVersion === pendingOperationMetadataFormatVersion &&
    isRecord(value.audit) &&
    isRecord(value.recovery)
  ) {
    return { metadata: value.audit, recoveryMetadata: value.recovery };
  }

  // Rows created before the split stored one flat object. Treat it as both
  // projections so already-valid pending operations remain recoverable.
  const legacyMetadata = isRecord(value) ? value : {};
  return { metadata: legacyMetadata, recoveryMetadata: legacyMetadata };
}

function sanitizeRecoveryMetadata(metadata: PendingOperationRecoveryMetadata): Record<string, unknown> {
  const sanitized = stripForbidden(metadata) as Record<string, unknown>;
  return {
    ...Object.fromEntries(pendingOperationRecoveryMetadataStringFields.flatMap((field) => (typeof sanitized[field] === 'string' ? [[field, sanitized[field]]] : []))),
    ...(typeof sanitized.durationMs === 'number' && Number.isFinite(sanitized.durationMs) && sanitized.durationMs >= 0 ? { durationMs: sanitized.durationMs } : {}),
    ...(typeof sanitized.success === 'boolean' ? { success: sanitized.success } : {}),
  };
}

function toRow(row: typeof pendingOperations.$inferSelect): PendingOperationRow {
  const storedMetadata = decodeStoredMetadata(row.metadata);
  return {
    id: row.id,
    kind: row.kind,
    chatId: row.chatId,
    requestPayload: row.requestPayload as Record<string, unknown>,
    metadata: storedMetadata.metadata,
    recoveryMetadata: storedMetadata.recoveryMetadata,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    leaseExpiresAt: row.leaseExpiresAt,
    result: (row.result as Record<string, unknown> | null) ?? null,
    auditStatus: row.auditStatus,
  };
}

/**
 * ============================================================================
 * BOTS-9: shared write-ahead and durable audit-debt outbox.
 * ============================================================================
 * For external operations, `execute()` durably records the intent in
 * `moderation.pending_operations` before the call. For audit-only rows, the
 * already-observable operation remains represented by its upstream durable
 * source until `execute()` stores the finalization debt. Once the row exists,
 * {@link PendingOperationsOutbox.recoverPending}/
 * {@link PendingOperationsOutbox.startWorker} find it again and recover, per
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
  private defaultFinalizer: PendingOperationFinalizer | undefined;
  private metadataSanitizer: PendingOperationMetadataSanitizer | undefined;
  /** Every background sweep currently in flight, so {@link stopAndDrain} can await them before the process tears down its database pool. */
  private readonly activeSweeps = new Set<Promise<unknown>>();

  public constructor(
    private readonly db: DrizzleDatabase,
    private readonly logger: Logger,
    private readonly resolvers: PendingOperationResolvers,
    private readonly maxAttempts: number = PENDING_OPERATION_MAX_ATTEMPTS,
    private readonly callTimeoutMs: number = PENDING_OPERATION_CALL_TIMEOUT_MS,
    private readonly leaseDurationMs: number = PENDING_OPERATION_LEASE_DURATION_MS,
  ) {}

  /** Used when execute()/worker omit onFinal (S3/Rabbit live path). */
  public setDefaultFinalizer(onFinal: PendingOperationFinalizer): void {
    this.defaultFinalizer = onFinal;
  }

  /** Applies policy-aware metadata filtering before WAL rows are inserted. */
  public setMetadataSanitizer(sanitizer: PendingOperationMetadataSanitizer): void {
    this.metadataSanitizer = sanitizer;
  }

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
    return this.executeRow(row, executor, onFinal);
  }

  /**
   * Resumes an already-written operation without creating a new intent.
   * Audit-only checkpoints use this on upstream redelivery: the existence of
   * the row proves the observable work already completed, so only its durable
   * finalization may run again.
   */
  public async resume(idempotencyKey: string, executor: PendingOperationExecutor, onFinal?: PendingOperationFinalizer): Promise<PendingOperationResult | undefined> {
    const row = await this.findByIdempotencyKey(idempotencyKey);
    return row ? this.executeRow(row, executor, onFinal) : undefined;
  }

  private async executeRow(row: PendingOperationRow, executor: PendingOperationExecutor, onFinal?: PendingOperationFinalizer): Promise<PendingOperationResult> {
    if (row.status === 'succeeded' || row.status === 'failed' || (row.status === 'unknown' && row.nextAttemptAt === null)) {
      const outcome: AttemptOutcome = row.result ? { status: row.status, result: row.result } : { status: row.status };
      // The original attempt resolved earlier — possibly with an audit that
      // never got written. A redelivery reaching this branch is exactly the
      // moment to complete that audit (idempotently). A row already marked
      // 'written'/'policy_skipped' is skipped here (retention-tombstone:
      // the audit existed once, retention may have purged it, and it must
      // NOT be resurrected).
      const auditFinalized = (await this.finalizeAudit(row, outcome, onFinal)) !== 'failed';
      return { row, outcome, isFinal: true, duplicate: true, auditFinalized };
    }
    const result = await this.attemptById(row, executor);
    if (result.isFinal) {
      const auditFinalized = (await this.finalizeAudit(result.row, result.outcome, onFinal)) !== 'failed';
      return { ...result, auditFinalized };
    }
    return { ...result, auditFinalized: true };
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
      const claim = await this.claimNextDue();
      if (!claim) break; // nothing eligible left this sweep
      const claimed = claim.row;
      if (claim.interruptedNonRetryable) {
        const outcome: AttemptOutcome = { status: 'unknown', result: interruptedOperationResult };
        this.logger.warn({
          event: 'pending_operations.recover.unknown_non_retryable',
          details: { kind: claimed.kind, id: claimed.id, attemptCount: claimed.attemptCount },
        });
        await this.finalizeAudit(claimed, outcome, onFinal);
        continue;
      }
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
   * Stops new work AND waits for the sweep already in flight to finish —
   * BOTS-9 review round-2 (MEDIUM): `stopWorker()` alone returned the
   * instant the timer was cleared, so shutdown could close the DB pool
   * while a sweep was mid-`finalizeAudit`, stranding rows as
   * `in_progress`/`audit_status='pending'` and causing a re-run of the
   * whole operation after restart. Bounded by `timeoutMs` so a wedged
   * sweep (e.g. an executor hanging on a dead network) can't block SIGTERM
   * forever; anything still in flight is logged for the operator.
   */
  public async stopAndDrain(timeoutMs = this.leaseDurationMs): Promise<void> {
    this.stopWorker();
    const inFlight = [...this.activeSweeps];
    if (inFlight.length === 0) return;
    let timedOut = false;
    const bounded = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });
    await Promise.race([Promise.allSettled(inFlight), bounded]);
    if (timedOut) {
      this.logger.warn({ event: 'pending_operations.shutdown.drain_timeout', details: { inFlight: inFlight.length } });
    }
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
      const sweep = this.recoverPending(onFinal)
        .catch((error: unknown) => {
          this.logger.error({ event: 'pending_operations.worker.tick_failed', error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
        })
        .finally(() => {
          this.activeSweeps.delete(sweep);
          if (!this.workerStopped) this.workerTimer = setTimeout(tick, pollIntervalMs);
        });
      this.activeSweeps.add(sweep);
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
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const inserted = await this.db
      .insert(pendingOperations)
      .values({
        kind: input.kind,
        chatId: input.chatId,
        idempotencyKey: input.idempotencyKey,
        requestPayload: stripForbidden(input.requestPayload),
        metadata: await this.prepareStoredMetadata(input),
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

  private async findByIdempotencyKey(idempotencyKey: string): Promise<PendingOperationRow | undefined> {
    const [row] = await this.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, idempotencyKey)).limit(1);
    return row ? toRow(row) : undefined;
  }

  private async prepareStoredMetadata(input: EnqueueExternalOperationInput): Promise<Record<string, unknown>> {
    const metadata = input.metadata ? stripForbidden(input.metadata) : {};
    const auditMetadata =
      !this.metadataSanitizer || input.auditEvent === undefined
        ? metadata
        : stripForbidden(
            await this.metadataSanitizer({
              kind: input.kind,
              chatId: input.chatId,
              idempotencyKey: input.idempotencyKey,
              auditEvent: input.auditEvent,
              metadata,
            }),
          );
    if (input.recoveryMetadata === undefined) return auditMetadata;
    return {
      formatVersion: pendingOperationMetadataFormatVersion,
      audit: auditMetadata,
      recovery: sanitizeRecoveryMetadata(input.recoveryMetadata),
    };
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
  private async claimNextDue(): Promise<ClaimedPendingOperation | undefined> {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const candidates = await tx
        .select({ id: pendingOperations.id, kind: pendingOperations.kind, status: pendingOperations.status })
        .from(pendingOperations)
        .where(this.eligibilityCondition(now))
        .orderBy(pendingOperations.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      const candidate = candidates[0];
      if (!candidate) return undefined;

      if (candidate.status === 'in_progress' && this.resolvers.get(candidate.kind) && !this.resolvers.retryAfterUnknown(candidate.kind)) {
        const interrupted = await tx
          .update(pendingOperations)
          .set({ status: 'unknown', nextAttemptAt: null, result: interruptedOperationResult, workerId: null, leaseExpiresAt: null, updatedAt: now })
          .where(eq(pendingOperations.id, candidate.id))
          .returning();
        if (!interrupted[0]) return undefined;
        return { row: toRow(interrupted[0]), interruptedNonRetryable: true };
      }

      const claimed = await tx
        .update(pendingOperations)
        .set({ status: 'in_progress', workerId: this.workerId, leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs), attemptCount: sql`${pendingOperations.attemptCount} + 1`, lastAttemptAt: now, updatedAt: now })
        .where(eq(pendingOperations.id, candidate.id))
        .returning();
      return claimed[0] ? { row: toRow(claimed[0]), interruptedNonRetryable: false } : undefined;
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
    if (this.resolvers.get(row.kind) && !this.resolvers.retryAfterUnknown(row.kind)) {
      const now = new Date();
      const interrupted = await this.db
        .update(pendingOperations)
        .set({ status: 'unknown', nextAttemptAt: null, result: interruptedOperationResult, workerId: null, leaseExpiresAt: null, updatedAt: now })
        .where(and(eq(pendingOperations.id, row.id), eq(pendingOperations.status, 'in_progress'), or(isNull(pendingOperations.leaseExpiresAt), lte(pendingOperations.leaseExpiresAt, now))))
        .returning();
      if (interrupted[0]) {
        const terminal = toRow(interrupted[0]);
        return { row: terminal, outcome: { status: 'unknown', result: interruptedOperationResult }, isFinal: true, duplicate: true, auditFinalized: true };
      }
    }
    const claimed = await this.claimById(row.id);
    if (!claimed) {
      // Lost the claim — someone else (a concurrent call, or the polling
      // worker) already holds this row's lease right now.
      return { row, outcome: { status: 'unknown' }, isFinal: false, duplicate: true, auditFinalized: true };
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
      return { row: { ...claimed, status: 'succeeded', result: resultPayload }, outcome: { status: 'succeeded', result: resultPayload }, isFinal: true, duplicate: false, auditFinalized: true };
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
        return { row: { ...claimed, status: 'failed', result: confirmed }, outcome: { status: 'failed', result: confirmed }, isFinal: true, duplicate: false, auditFinalized: true };
      }
      // UNCONFIRMED — timeout, network error, or any other non-Telegram
      // failure. We do not know whether Telegram applied the change.
      return this.markUnknownAndMaybeRetry(claimed, error);
    }
  }

  /** A CAS on resolve() failed: this worker's lease was reclaimed by someone else before it could report its own result — see the class doc's "LATE COMPLETION" note. Logged distinctly because it's a rare, operationally important signal, and reported as non-final/duplicate so the caller never writes an audit record for an outcome this worker no longer has authority over. */
  private orphanedResult(row: PendingOperationRow, attempted: AttemptOutcome): PendingOperationResult {
    this.logger.error({ event: 'pending_operations.attempt.lease_lost', details: { kind: row.kind, id: row.id, attemptedStatus: attempted.status } });
    return { row, outcome: { status: 'unknown' }, isFinal: false, duplicate: true, auditFinalized: true };
  }

  private async markUnknownAndMaybeRetry(row: PendingOperationRow, error: unknown): Promise<PendingOperationResult> {
    const attemptCount = row.attemptCount;
    // BOTS-9 review round-2 (BLOCKER-2): per-kind retry policy. A kind
    // declared non-retryable-after-unknown (`telegram.deleteMessage`) is
    // terminal on the FIRST unknown — never blindly re-issued — because the
    // original request may have landed and a re-issued destructive call
    // would misreport a real success as a confirmed failure.
    const retryable = this.resolvers.retryAfterUnknown(row.kind);
    const exhausted = !retryable || attemptCount >= this.maxAttempts;
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
      event: exhausted ? (retryable ? 'pending_operations.attempt.unknown_exhausted' : 'pending_operations.attempt.unknown_non_retryable') : 'pending_operations.attempt.unknown_will_retry',
      details: { kind: row.kind, id: row.id, attemptCount, retryAfterUnknown: retryable, ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}) },
      error: errorSummary,
    });
    return {
      row: { ...row, status: 'unknown', result: errorSummary },
      outcome: { status: 'unknown', result: errorSummary },
      isFinal: exhausted,
      duplicate: false,
      auditFinalized: true,
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
   * 'pending' for the worker's backfill pass.
   *
   * BOTS-9 review round-2 (BLOCKER-1): `markAuditWritten()` is ONLY reached
   * after the finalizer returned an explicit `{status:'recorded'}`. A
   * `{status:'policy_skipped'}` result marks the row `policy_skipped`
   * instead (terminal, nothing owed). Any throw keeps the audit owed. A row
   * already marked `written`/`policy_skipped` is a retention tombstone: the
   * terminal audit existed (or was deliberately skipped) once, retention may
   * have purged the event, and the finalizer must NOT be re-invoked — that
   * would resurrect the event on redelivery.
   */
  private async finalizeAudit(row: PendingOperationRow, outcome: AttemptOutcome, onFinal: PendingOperationFinalizer | undefined): Promise<AuditFinalizeStatus> {
    const finalizer = onFinal ?? this.defaultFinalizer;
    if (!finalizer) return 'failed';
    if (row.auditStatus === 'written' || row.auditStatus === 'policy_skipped') return 'recorded';
    try {
      const result = await finalizer(row, outcome);
      if (result.status === 'policy_skipped') {
        await this.markAuditSkipped(row.id);
        return 'policy_skipped';
      }
      await this.markAuditWritten(row.id);
      return 'recorded';
    } catch (error: unknown) {
      this.logger.error({
        event: 'pending_operations.audit.finalization_failed',
        details: { kind: row.kind, id: row.id, outcomeStatus: outcome.status },
        error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
      });
      return 'failed';
    }
  }

  private async markAuditWritten(id: string): Promise<void> {
    await this.db
      .update(pendingOperations)
      .set({ auditStatus: 'written', auditWorkerId: null, auditLeaseExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(pendingOperations.id, id), eq(pendingOperations.auditStatus, 'pending')));
  }

  private async markAuditSkipped(id: string): Promise<void> {
    await this.db
      .update(pendingOperations)
      .set({ auditStatus: 'policy_skipped', auditWorkerId: null, auditLeaseExpiresAt: null, updatedAt: new Date() })
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
      const finalizer = onFinal ?? this.defaultFinalizer;
      if (!finalizer) {
        await this.releaseAuditClaim(claimed.id);
        this.logger.warn({ event: 'pending_operations.audit.backfill_no_finalizer', details: { kind: claimed.kind, id: claimed.id } });
        return;
      }
      const outcome: AttemptOutcome = claimed.result ? { status: claimed.status as AttemptOutcome['status'], result: claimed.result } : { status: claimed.status as AttemptOutcome['status'] };
      const status = await this.finalizeAudit(claimed, outcome, finalizer);
      if (status === 'failed') {
        continue;
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

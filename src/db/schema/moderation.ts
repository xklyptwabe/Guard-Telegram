import { index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

export const moderationSchema = pgSchema('moderation');

/**
 * BOTS-9's write-ahead log / outbox for *external* operations — currently
 * Telegram Bot API calls that change moderation state (ban, unban, restrict,
 * unrestrict, kick, and the bot's own message deletions). This is a
 * different concern from `audit.outbox` (BOTS-6/7), which delivers an
 * *already-recorded* audit event onward to a destination. This table exists
 * to make the external call itself reliable:
 *
 *  1. A row is written here *before* the Telegram API is called ("write
 *     ahead") — `status = 'pending'`.
 *  2. The call is attempted; the row moves to `in_progress`, tagged with a
 *     `worker_id` and a `lease_expires_at` (BOTS-9 review BLOCKER-2) — no
 *     row is ever executed just because it happens to already read
 *     `in_progress`; a worker only acts on a row once it has *itself*
 *     atomically claimed the lease.
 *  3. On a confirmed response from Telegram (success or a `GrammyError`,
 *     i.e. Telegram itself answered) the row is resolved to `succeeded` or
 *     `failed`.
 *  4. If no confirmed response arrives (timeout, network failure, or the
 *     process crashes/restarts mid-call) the row is left at `unknown` — we
 *     genuinely do not know whether Telegram applied the change. A lease
 *     that expires without resolution (crash, killed process) is only
 *     reclaimed once `lease_expires_at` has actually passed — not
 *     immediately, so a slow-but-alive worker doesn't get its row stolen
 *     out from under it.
 *
 * `idempotencyKey` lets a retry (or a redelivered Telegram Update asking for
 * the same action) resolve to the *same* row instead of re-issuing the call
 * or creating a second audit record — see `PendingOperationsOutbox`.
 */
export const pendingOperations = moderationSchema.table(
  'pending_operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Dot-separated operation kind, e.g. `telegram.banChatMember` — used to look up the retry handler on restart. */
    kind: text('kind').notNull(),
    chatId: text('chat_id').notNull(),
    /** The Telegram API call's own arguments, exactly as they will be/were sent. Never contains secrets — enforced by the same forbidden-key scan the audit layer uses. */
    requestPayload: jsonb('request_payload').notNull(),
    /** Everything needed to reconstruct the eventual audit record (actor, target, action, reason) — deliberately kept separate from requestPayload so requestPayload always stays exactly what gets forwarded to Telegram. Read by PendingOperationsOutbox.recoverPending()'s callers after a restart, when there is no live Update/actor on the call stack to ask. */
    metadata: jsonb('metadata'),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', { enum: ['pending', 'in_progress', 'succeeded', 'failed', 'unknown'] }).notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    /** Set only once the row leaves `pending`/`in_progress` for a terminal-ish state. */
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** Opaque id of whichever worker instance currently believes it owns this row — BOTS-9 review BLOCKER-2. Every state-changing UPDATE past the initial claim is conditioned on `worker_id` matching, so a worker whose lease already expired (and got reclaimed) can never clobber the new owner's work. */
    workerId: text('worker_id'),
    /** How long the current claim is valid for — a row is only eligible for reclaim once this has passed, never just because it's `in_progress`. */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /**
     * BOTS-9 review finding (HIGH-3): whether the operation's one-and-only
     * terminal audit event has actually been written. 'pending' from
     * write-ahead until the audit insert commits; 'written' after. A crash
     * between operation resolution and audit completion leaves 'pending' —
     * the worker's audit-backfill pass then retries the audit (idempotent
     * via the `...:audit` idempotency key) without re-invoking the executor.
     *
     * BOTS-9 review round-2 (BLOCKER-1): 'policy_skipped' is the terminal
     * counterpart of 'written' for a *deliberate* policy decision — the
     * resolved audit policy disabled the event, so no record is owed and
     * the backfill pass must stop retrying the row. Only an explicit
     * `{status:'policy_skipped'}` finalizer result may set it; any
     * infrastructure failure leaves 'pending'.
     */
    auditStatus: text('audit_status', { enum: ['pending', 'written', 'policy_skipped'] }).notNull().default('pending'),
    /** Lease pair for the audit-backfill claim — separate from the operation's own worker_id so backfilling a terminal row never looks like an operation retry. */
    auditWorkerId: text('audit_worker_id'),
    auditLeaseExpiresAt: timestamp('audit_lease_expires_at', { withTimezone: true }),
    /** Telegram's own response once confirmed (success payload, or a GrammyError's error_code/description). Never the raw HTTP transport error, which may carry connection details. */
    result: jsonb('result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('pending_operations_idempotency_key_idx').on(table.idempotencyKey),
    index('pending_operations_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('pending_operations_lease_idx').on(table.status, table.leaseExpiresAt),
    index('pending_operations_chat_idx').on(table.chatId),
  ],
);

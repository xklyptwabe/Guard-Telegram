import { index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

export const moderationSchema = pgSchema('moderation');

/**
 * BOTS-9's shared durable operation/audit-debt outbox. It writes ahead
 * external operations such as Telegram moderation calls, and retains
 * audit-only checkpoints after already-observable command/Rabbit work. This
 * is a different concern from `audit.outbox` (BOTS-6/7), which delivers an
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
    /** Stable bot/deployment owner. Background recovery only claims rows owned by the current bot instance. */
    ownerId: text('owner_id').notNull().default('legacy'),
    /** Dot-separated operation kind, e.g. `telegram.banChatMember` or `command.audit` — used to look up the recovery handler after restart. */
    kind: text('kind').notNull(),
    chatId: text('chat_id').notNull(),
    /** The Telegram API call's own arguments, exactly as they will be/were sent. Retained only while execution or audit recovery is still owed, then minimized to an empty tombstone payload. */
    requestPayload: jsonb('request_payload').notNull(),
    /** Everything needed to reconstruct the eventual audit record — deliberately kept separate from requestPayload and cleared by the DB once terminal audit finalization succeeds or is deliberately policy-skipped. */
    metadata: jsonb('metadata'),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Immutable digest of the logical operation. It survives payload minimization so one key cannot alias different work. */
    operationFingerprint: text('operation_fingerprint'),
    /** Stable state domain used to prevent an older retry from overwriting a newer intent for the same remote entity. */
    supersessionKey: text('supersession_key'),
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
    /** Telegram's own response once confirmed. Available to the audit finalizer, then cleared together with the recovery payload once no audit debt remains. */
    result: jsonb('result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('pending_operations_owner_idempotency_key_idx').on(table.ownerId, table.idempotencyKey),
    index('pending_operations_owner_status_next_attempt_idx').on(table.ownerId, table.status, table.nextAttemptAt),
    index('pending_operations_owner_lease_idx').on(table.ownerId, table.status, table.leaseExpiresAt),
    index('pending_operations_owner_chat_idx').on(table.ownerId, table.chatId),
    index('pending_operations_owner_supersession_created_idx').on(table.ownerId, table.supersessionKey, table.createdAt),
  ],
);

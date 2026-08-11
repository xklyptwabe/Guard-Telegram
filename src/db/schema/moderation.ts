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
 *  2. The call is attempted; the row moves to `in_progress`.
 *  3. On a confirmed response from Telegram (success or a `GrammyError`,
 *     i.e. Telegram itself answered) the row is resolved to `succeeded` or
 *     `failed`.
 *  4. If no confirmed response arrives (timeout, network failure, or the
 *     process crashes/restarts mid-call) the row is left at `unknown` — we
 *     genuinely do not know whether Telegram applied the change.
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
    /** Telegram's own response once confirmed (success payload, or a GrammyError's error_code/description). Never the raw HTTP transport error, which may carry connection details. */
    result: jsonb('result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('pending_operations_idempotency_key_idx').on(table.idempotencyKey),
    index('pending_operations_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
    index('pending_operations_chat_idx').on(table.chatId),
  ],
);

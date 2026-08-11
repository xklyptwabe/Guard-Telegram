# External operation outbox (BOTS-9)

Moderation actions (`banChatMember`, `unbanChatMember`, `restrictChatMember`, `deleteMessage`) are calls to an external system — the Telegram Bot API — that can fail in ways a normal database transaction can't paper over: the process can crash mid-call, the network can drop the response after Telegram already applied the change, or Telegram can take longer than we're willing to wait. `moderation.pending_operations` (`src/db/schema/moderation.ts`) and `PendingOperationsOutbox` (`src/lib/moderation/pendingOperationsOutbox.ts`) exist to make these calls reliable and their outcome auditable, without ever claiming to know something we don't.

This is a distinct concern from `audit.outbox` (BOTS-6/7), which delivers an *already-recorded* audit event onward to a destination. `moderation.pending_operations` exists to make the *external call itself* reliable, before any audit event exists.

## Contract

1. **Write-ahead.** Before any Telegram call, a row is inserted with `status = 'pending'` and a caller-supplied `idempotencyKey`. If a row for that key already exists, the row is looked up instead of inserted again.
2. **Claim.** The row is atomically moved to `in_progress` (`UPDATE ... WHERE status IN ('pending','unknown') RETURNING`) immediately before the call — this is what stops two concurrent callers (or a live command racing the recovery pass) from dispatching the same external call twice.
3. **Resolve.**
   - A confirmed response — success, or a `GrammyError` (Telegram itself answered with an error) — is terminal: `succeeded` or `failed`. A `failed` result is never retried; retrying an authoritative rejection (missing admin rights, etc.) would just fail again.
   - Anything else — a timeout, a network error, any non-`GrammyError` exception — means **we do not know** whether Telegram applied the change. The row is left at `unknown`, with `next_attempt_at` set for a backoff retry, up to `PENDING_OPERATION_MAX_ATTEMPTS` (`src/constants.ts`). Once retries are exhausted, `unknown` becomes the permanent, final state.
4. **Recover.** `PendingOperationsOutbox.recoverPending()` — called once at startup, after `bot.init()`, before the transport starts accepting new updates — finds any row left `pending`/`in_progress` (the process died mid-call) or `unknown` with a due retry, and re-attempts it using a resolver registered by `kind` (e.g. `telegram.banChatMember`). `ModerationService` registers all of its resolvers eagerly in its constructor specifically so a fresh process can recover rows even before any command has run.

## One final audit record

`каждая операция создаёт одну итоговую запись` (each operation creates exactly one final record): `PendingOperationsOutbox` never writes an audit event itself — it only reports whether an outcome is `isFinal`. `ModerationService` only calls into the audit layer (`moderation.action` / `message.deleted`) when `isFinal` is true: immediately for a confirmed `succeeded`/`failed`, or once — the moment retries are exhausted — for a terminal `unknown`. An interim `unknown` with retries remaining is never audited; the *next* attempt's outcome is the one that counts.

This is also why `PendingOperationsOutbox.execute()`'s write-ahead step doubles as idempotency for redelivered Telegram Updates: a retried command (or a Bot API redelivery of the same Update) that produces the same `idempotencyKey` finds the existing row already resolved and returns its outcome without invoking the executor — or Telegram — a second time.

## Recovering *which* audit record

A row resolving during `recoverPending()` has no live command, actor, or Update on the call stack — the original request/response cycle is long gone. Everything needed to reconstruct the eventual `moderation.action`/`message.deleted` audit record (actor, target, action, reason) is therefore written ahead into `pending_operations.metadata`, deliberately kept separate from `request_payload` (which stays exactly what gets forwarded to Telegram, nothing more). `ModerationService.recoverPending()`'s callback reads `row.metadata` and `row.kind` to dispatch to the right audit producer; a row somehow missing that metadata is logged (`audit.moderation_action.recovered_without_metadata`) and skipped rather than guessed at.

The audit record's own idempotency key is always the pending operation's own `idempotencyKey` with an `:audit` suffix — reused, never re-derived from `getUpdateContext()` — so it resolves identically whether written from a live command or from recovery.

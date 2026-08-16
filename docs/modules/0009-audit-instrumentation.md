# Audit instrumentation (BOTS-9)

BOTS-7 defined the full audit event registry (`src/lib/audit/definitions.ts`) — schemas, allowlists, subject mappings — for twelve event types, but as of BOTS-8 only two of them (`module.state.changed`, `command.executed`) and the S3/RabbitMQ integration calls had a real producer anywhere in the app. This document covers the remaining six, wired up in BOTS-9, and — just as importantly — what the Telegram Bot API genuinely does *not* let us observe, so nothing here overclaims.

## What triggers each event

| Event | Trigger | Producer |
| --- | --- | --- |
| `member.status.changed` | a real `chat_member` update | `src/lib/audit/memberAudit.ts`, via the `membership-audit` module |
| `bot.membership.changed` | a real `my_chat_member` update | `src/lib/audit/botMembershipAudit.ts`, registered directly in `core/updates.ts` |
| `moderation.action` | `/ban`, `/unban`, `/restrict`, `/unrestrict`, `/kick` | `src/lib/moderation/moderationService.ts`, via the `moderation` module |
| `message.edited` | a real `edited_message` update only — `edited_channel_post` is unsupported (channel posts carry no `from`, so the editor is unknowable without fabricating an actor) | `src/lib/audit/messageAudit.ts`, via the `message-audit` module |
| `message.deleted` | the bot's own `deleteMessage` call (`/delmsg`) | `src/lib/audit/messageAudit.ts`, called from `ModerationService.deleteMessage` |
| `chat.settings.changed` | `/setlocale` | `src/lib/chatSettings.ts`, via the `chat-settings` module |

`chat_member` and `edited_message` are **not** sent by Telegram unless listed in `TELEGRAM_ALLOWED_UPDATES` — the default in `src/config.ts`/`.env.example` now includes both, but a deployment that overrides that variable must keep them if it wants these two events to fire at all.

## `bot.membership.changed` is never module-gated

Every other event above is produced from inside a toggleable module's `updateHandlers`/commands, consistent with its `canBeDisabled: true` definition — a chat's admins can turn that observability off like any other module. `bot.membership.changed` is different: its definition is `canBeDisabled: false`, because whether the bot itself can still act in a chat is core infrastructure, not a feature. Its producer is registered directly on the bot in `core/updates.ts` (`registerBotMembershipAudit`), entirely outside `registerModuleUpdateHandlers`'s module-enabled check.

## `entity_snapshots`, "the last allowed version", and `before_status = not_observed`

`AuditService.recordEntityChange` keeps one row per subject in `audit.entity_snapshots` holding the most recent state we're allowed to know about that subject — "allowed" meaning it has already passed the same per-chat, per-event-type field allowlist (`allowMessageTextLogging`, etc.) that governs the `events` table itself. `message.edited` updates that row every time; a later `message.deleted` or another `message.edited` reads it back via `src/lib/audit/entitySnapshotLookup.ts`.

When nothing has ever been recorded for a subject — a message deleted before any edit was observed, a member whose very first `chat_member` update this bot ever saw — `before` is `not_observed`, never a fabricated guess. This is deliberate and shows up in `events.before_snapshot_status`.

## What is *not* claimed here

The Telegram Bot API has:
- **No `deleted_message` update, at all.** A user or another admin deleting a message through their own Telegram client produces nothing a bot can subscribe to, poll, or reconstruct — not even a gap that's reliably attributable to a deletion rather than, say, a message the bot was never shown in the first place. Guessing from an ID gap is not an observation, so this codebase does not do it.
- **No way to fetch a message that no longer exists**, so even a deletion the bot *does* know about (because it performed it) carries only whatever was already captured before the delete — never re-fetched content.

Concretely: `message.deleted` is only ever raised from `ModerationService.deleteMessage`, driven by the `/delmsg` command. There is no Telegram update handler for "message deleted" anywhere in this codebase, and there should never be one that infers deletion from message-ID gaps, missing replies, or similar heuristics — see the module doc comment at the top of `src/lib/audit/messageAudit.ts` for the same note in code.

## Out-of-order and incomplete updates

`chat_member` and `my_chat_member` updates are not guaranteed to arrive in the order Telegram generated them (redelivery, retries, webhook vs. long-polling races). Both producers compare the incoming update's own `date` against the `observedAt` already recorded for that subject in `entity_snapshots`; an update older than what's on file is still audited (for a complete history, tagged `outOfOrder: true` in the event's `metadata`) but is never allowed to regress the "current" snapshot back to a stale status.

An incomplete update — `new_chat_member`/its `user`/`status` missing, or a status that doesn't match Telegram's known set — is logged (`audit.member_status_changed.incomplete_update` / `audit.bot_membership_changed.incomplete_update`) and skipped rather than guessed at.

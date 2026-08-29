# Audit instrumentation (BOTS-9)

BOTS-7 defined the full audit event registry (`src/lib/audit/definitions.ts`) — schemas, allowlists, subject mappings — for twelve event types, but as of BOTS-8 only two of them (`module.state.changed`, `command.executed`) and the S3/RabbitMQ integration calls had a real producer anywhere in the app. This document covers the remaining six, wired up in BOTS-9, and — just as importantly — what the Telegram Bot API genuinely does *not* let us observe, so nothing here overclaims.

## What triggers each event

| Event | Trigger | Producer |
| --- | --- | --- |
| `member.status.changed` | a real `chat_member` update | `src/lib/audit/memberAudit.ts`, via the `membership-audit` module |
| `bot.membership.changed` | a real `my_chat_member` update | `src/lib/audit/botMembershipAudit.ts`, registered directly in `core/updates.ts` |
| `moderation.action` | `/ban`, `/unban`, `/restrict`, `/unrestrict`, `/kick` | `src/lib/moderation/moderationService.ts`, via the `moderation` module |
| `message.edited` | a real `edited_message` or `edited_channel_post` update; actor fields are omitted when Telegram does not expose `from` | `src/lib/audit/messageAudit.ts`, via the `message-audit` module |
| `message.deleted` | the bot's own `deleteMessage` call (`/delmsg`) | `src/lib/audit/messageAudit.ts`, called from `ModerationService.deleteMessage` |
| `chat.settings.changed` | `/setlocale` | `src/lib/chatSettings.ts`, via the `chat-settings` module |

`chat_member`, `edited_message`, `channel_post`, and `edited_channel_post` are **not** sent by Telegram unless listed in `TELEGRAM_ALLOWED_UPDATES` — the default in `src/config.ts`/`.env.example` includes all four, but a deployment that overrides that variable must keep the update types it wants to observe. Telegram retains the previous `allowed_updates` selection when a later polling or webhook request omits it, so deployments must configure this list explicitly rather than rely on Telegram-side history.

## `bot.membership.changed` is never module-gated

Every other event above is produced from inside a toggleable module's `updateHandlers`/commands, consistent with its `canBeDisabled: true` definition — a chat's admins can turn that observability off like any other module. `bot.membership.changed` is different: its definition is `canBeDisabled: false`, because whether the bot itself can still act in a chat is core infrastructure, not a feature. Its producer is registered directly on the bot in `core/updates.ts` (`registerBotMembershipAudit`), entirely outside `registerModuleUpdateHandlers`'s module-enabled check.

## `entity_snapshots`, "the last allowed version", and `before_status = not_observed`

`AuditService.recordEntityChange` keeps one row per subject in `audit.entity_snapshots` holding the most recent state we're allowed to know about that subject — "allowed" meaning it has already passed the same per-chat, per-event-type field allowlist (`allowMessageTextLogging`, etc.) that governs the `events` table itself. Ordinary `message` and `channel_post` updates refresh that row without creating a synthetic audit event; `message.edited` updates it as part of its event. A later `message.deleted` or another `message.edited` reads it back via `src/lib/audit/entitySnapshotLookup.ts`.

When nothing has ever been recorded for a subject — a message deleted before any edit was observed, a member whose very first `chat_member` update this bot ever saw — `before` is `not_observed`, never a fabricated guess. This is deliberate and shows up in `events.before_snapshot_status`.

## Telegram platform boundary

This service uses the HTTP-based [Telegram Bot API](https://core.telegram.org/bots/api) through grammY, with either long polling or a webhook. Those delivery modes are mutually exclusive. The repository contains no MTProto client, TDLib integration, Telegram user session, or userbot; Telegram's separately documented [MTProto bot API](https://core.telegram.org/api/bots) is outside this service's architecture and support contract.

Audit coverage starts only after Telegram delivers an update type selected by `TELEGRAM_ALLOWED_UPDATES`. The Bot API's [`allowed_updates`](https://core.telegram.org/bots/api#getupdates) filter therefore defines an observability boundary: an update excluded by a deployment cannot be reconstructed later by this service. Changing the selection does not retroactively alter updates Telegram created before the change, and webhook and polling retries may produce duplicates; the application's idempotency and ordering controls remain required.

A Bot API call timing out is not proof that Telegram rejected it. If the request may have reached Telegram but no authoritative response was received, an external operation is finalized as `unknown`, not guessed to be `failed` or `succeeded`. A confirmed Bot API error is `failed`. Recovery can retry or reconcile only with the information Telegram actually exposes; it cannot invent a provider state.

## What is *not* claimed here

The Telegram Bot API has:
- **No general `deleted_message` update for ordinary bot-visible chats.** The current [`Update`](https://core.telegram.org/bots/api#update) contract has `deleted_business_messages` for messages of a connected business account, but this repository has no business-connection deletion producer and does not map that update to `message.deleted`. A user or another admin deleting an ordinary message through their Telegram client produces nothing this service can subscribe to, poll, or reconstruct. Guessing from an ID gap is not an observation, so this codebase does not do it.
- **No way to fetch a message that no longer exists**, so even a deletion the bot *does* know about (because it performed it) carries only whatever was already captured before the delete — never re-fetched content.

Concretely: `message.deleted` is only ever raised from `ModerationService.deleteMessage`, driven by the `/delmsg` command. There is no Telegram update handler for "message deleted" anywhere in this codebase, and there should never be one that infers deletion from message-ID gaps, missing replies, or similar heuristics — see the module doc comment at the top of `src/lib/audit/messageAudit.ts` for the same note in code.

## Out-of-order and incomplete updates

`chat_member` and `my_chat_member` updates are not guaranteed to arrive in the order Telegram generated them (redelivery, retries, webhook vs. long-polling races). Both producers compare the incoming update's own `date` against the `observedAt` already recorded for that subject in `entity_snapshots`; an update older than what's on file is still audited (for a complete history, tagged `outOfOrder: true` in the event's `metadata`) but is never allowed to regress the "current" snapshot back to a stale status.

An incomplete update — `new_chat_member`/its `user`/`status` missing, or a status that doesn't match Telegram's known set — is logged (`audit.member_status_changed.incomplete_update` / `audit.bot_membership_changed.incomplete_update`) and skipped rather than guessed at.

# Commands, callbacks, permissions, and idempotency

The command registrar builds one validated union and sets the Telegram menu for RU and EN. The menu does not grant access. The dispatcher checks the current chat-module state, chat-scoped administrator role, in-memory fallback cooldown, and a command-specific Zod schema before invoking the command.

Each platform update first records only `(bot_id, update_id)` using `ON CONFLICT DO NOTHING`. A duplicate stops before business logic or a reply. Chat/user anchors record IDs and language only, not update contents.

Callbacks use `v1:<command>:<base64url-arguments>`. The common handler parses and validates the data, delegates to the same command dispatcher, and always calls `answerCallbackQuery`. `/start` payloads are a module boundary and require a signed or one-time server-side scheme for sensitive actions.

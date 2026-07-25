# ADR 0002: union command menu

Telegram command scopes are hints rather than an authorization boundary. The bot publishes the union of module commands for RU and EN instead of issuing Bot API calls for every chat-state change. The dispatcher enforces the current per-chat module state and replies with a localized disabled response when a visible command is unavailable.

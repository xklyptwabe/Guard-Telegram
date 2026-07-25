# ADR 0003: chat is the tenant

`chat_id` is the isolation boundary for configuration and module state. Telegram external identifiers are text to avoid precision loss. User identity can be referenced for permissions and cooldowns, but it does not make a global tenant. Forum topics are a reply-routing property (`message_thread_id`) within a chat, not a separate tenant.

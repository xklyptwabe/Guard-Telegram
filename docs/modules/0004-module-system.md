# Module system

Each `TelegramBotModule` has a unique kebab-case ID, metadata, global/local classification, default state, commands, optional update handlers, and optional lifecycle hooks. `src/core/loader.ts` rejects duplicate module IDs, update-handler IDs, command IDs, command names, invalid Telegram command names, mismatched module IDs, and invalid global/local defaults. Update handlers run only for enabled modules and are isolated so a failed handler cannot break the update pipeline.

Modules are collected only in `src/modules/index.ts`; they do not import one another. Cross-module notifications go through the typed internal event bus. An operation needing a result, transaction, or ordering belongs in a shared domain service or the database instead.

Per-chat state is a sparse override. A global module defaults enabled; a local module defaults disabled. The registry deletes an override once its value equals the default, so adding a module never requires creating rows for every chat.

# Logging, redaction, correlation, and health

`Logger` writes exactly one JSON object per line with timestamp, level, service, environment, event, and only available identifiers. Platform middleware creates a UUID correlation context per update through `AsyncLocalStorage`, so child logs automatically receive its `correlationId`, update ID, chat ID, and user ID. Command logs may include command name, module ID, and duration; they never include command text or callback data.

`redact` removes secret-named fields and credentials from URLs. Errors are normalized to name, message, and a redacted stack. Middleware errors, transport failures, permission/cooldown/payload rejections, optional-service degradation, module state changes, and RabbitMQ retry/DLQ paths all emit named events.

`healthSnapshot` intentionally contains only component state: database, selected transport, Redis, storage, and RabbitMQ. It cannot expose a message or an action payload.

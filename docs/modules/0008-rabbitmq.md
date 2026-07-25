# RabbitMQ bridge

The bridge is disabled by default and accepts `amqps://` only. When enabled, initial connection is fatal. It declares a durable `<namespace>.actions` topic exchange, a product action queue, a TTL retry queue that dead-letters back to the action route, and a product DLQ.

Publishes use a confirm channel, persistent delivery mode, and broker confirms. Consumers validate an action envelope, ACK only after a successful handler, retry a failed handler until `RABBITMQ_MAX_RETRIES`, and move exhausted or malformed actions to the DLQ. If retry/DLQ publishing fails, the original item is requeued.

Action payload schemas belong to their owning modules and must reject secrets, message text, and raw Telegram payloads unless the module has an explicit, documented legal basis to process them.

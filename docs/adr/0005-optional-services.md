# ADR 0005: optional services and failure policy

Redis and S3 are optional capability accelerators: their failures degrade behavior without replacing PostgreSQL truth. RabbitMQ is optional only when disabled; enabling it opts into reliable cross-service actions, so its first connection failure blocks startup. All remote dependencies use TLS.

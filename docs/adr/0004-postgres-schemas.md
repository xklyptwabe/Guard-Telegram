# ADR 0004: PostgreSQL schemas

Use `public` for stable Telegram anchors, `core` for platform records, and dedicated schemas for future domain modules. Drizzle schema definitions and generated migrations are the executable contract. Raw SQL is confined to generated migration artifacts, not application data paths.

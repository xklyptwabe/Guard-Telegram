CREATE TABLE IF NOT EXISTS "core"."consumed_envelopes" (
  "envelope_id" text PRIMARY KEY NOT NULL,
  "consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    GRANT SELECT, INSERT, DELETE ON core.consumed_envelopes TO telegram_bot;
  END IF;
END $$;

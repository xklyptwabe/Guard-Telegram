-- BOTS-9 follow-up: Rabbit consumer-side dedup is not a boolean
-- insert-before-handler marker anymore. A row only deduplicates once it is
-- `completed`; failed or expired processing rows remain retryable through
-- RabbitMQ redelivery.
ALTER TABLE "core"."consumed_envelopes" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'received';
--> statement-breakpoint
ALTER TABLE "core"."consumed_envelopes" ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "core"."consumed_envelopes" ADD COLUMN IF NOT EXISTS "worker_id" text;
--> statement-breakpoint
ALTER TABLE "core"."consumed_envelopes" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "core"."consumed_envelopes" ADD COLUMN IF NOT EXISTS "last_error" jsonb;
--> statement-breakpoint
ALTER TABLE "core"."consumed_envelopes" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "core"."consumed_envelopes" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
UPDATE "core"."consumed_envelopes"
SET "status" = 'completed',
    "attempt_count" = GREATEST("attempt_count", 1),
    "updated_at" = now()
WHERE "status" = 'received';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consumed_envelopes_status_check'
      AND conrelid = 'core.consumed_envelopes'::regclass
  ) THEN
    ALTER TABLE "core"."consumed_envelopes"
      ADD CONSTRAINT "consumed_envelopes_status_check"
      CHECK ("status" IN ('received', 'processing', 'completed', 'failed'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consumed_envelopes_attempt_count_check'
      AND conrelid = 'core.consumed_envelopes'::regclass
  ) THEN
    ALTER TABLE "core"."consumed_envelopes"
      ADD CONSTRAINT "consumed_envelopes_attempt_count_check"
      CHECK ("attempt_count" >= 0);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'consumed_envelopes_worker_status_check'
      AND conrelid = 'core.consumed_envelopes'::regclass
  ) THEN
    ALTER TABLE "core"."consumed_envelopes"
      ADD CONSTRAINT "consumed_envelopes_worker_status_check"
      CHECK ("worker_id" IS NULL OR "status" = 'processing');
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consumed_envelopes_status_lease_idx"
  ON "core"."consumed_envelopes" ("status", "lease_expires_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    REVOKE UPDATE ON core.consumed_envelopes FROM telegram_bot;
    GRANT UPDATE (
      status,
      attempt_count,
      worker_id,
      lease_expires_at,
      last_error,
      consumed_at,
      updated_at
    ) ON core.consumed_envelopes TO telegram_bot;
  END IF;
END $$;

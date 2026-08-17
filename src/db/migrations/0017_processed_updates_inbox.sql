-- BOTS-9 review finding (BLOCKER-5): `core.processed_updates` was a
-- boolean "seen it" marker inserted BEFORE the handler chain ran. A crash
-- or a handler exception after that insert left the update permanently
-- lost: redelivery found the row and skipped forever (at-most-once). This
-- turns the marker into a durable inbox state machine:
--
--   received -> processing -> completed
--                   \-> failed (awaiting redelivery, backoff-scheduled)
--
-- The raw Telegram Update is deliberately NOT stored (BLOCKER-4 forbids
-- persisting raw updates): reprocessing only happens when Telegram itself
-- redelivers the update, which is exactly the acceptance criterion
-- ("redelivery после partial failure продолжает обработку"). The row only
-- records *whether* processing completed, never the payload.
--
-- Legacy rows (written by the old insert-before-process code) are
-- backfilled to 'completed': the old semantics can't distinguish
-- completed from interrupted, and treating them as 'received' would
-- replay the entire backlog once after deploy.
ALTER TABLE "core"."processed_updates" ADD COLUMN "status" text NOT NULL DEFAULT 'received';
--> statement-breakpoint
ALTER TABLE "core"."processed_updates" ADD COLUMN "attempt_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "core"."processed_updates" ADD COLUMN "worker_id" text;
--> statement-breakpoint
ALTER TABLE "core"."processed_updates" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "core"."processed_updates" ADD COLUMN "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "core"."processed_updates" ADD COLUMN "last_error" jsonb;
--> statement-breakpoint
UPDATE "core"."processed_updates" SET "status" = 'completed' WHERE "status" = 'received';
--> statement-breakpoint
ALTER TABLE "core"."processed_updates" ADD CONSTRAINT "processed_updates_status_check" CHECK ("status" IN ('received', 'processing', 'completed', 'failed'));
--> statement-breakpoint
ALTER TABLE "core"."processed_updates" ADD CONSTRAINT "processed_updates_attempt_count_check" CHECK ("attempt_count" >= 0);
--> statement-breakpoint
-- Only an in-flight row may carry a worker claim; completed/failed/received
-- rows always have a null worker (released on completion, never set before
-- the claim).
ALTER TABLE "core"."processed_updates" ADD CONSTRAINT "processed_updates_worker_status_check" CHECK ("worker_id" IS NULL OR "status" = 'processing');
--> statement-breakpoint
CREATE INDEX "processed_updates_status_lease_idx" ON "core"."processed_updates" USING btree ("status", "lease_expires_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    GRANT UPDATE (
      status,
      attempt_count,
      worker_id,
      lease_expires_at,
      next_attempt_at,
      last_error,
      processed_at,
      updated_at
    ) ON core.processed_updates TO telegram_bot;
  END IF;
END $$;

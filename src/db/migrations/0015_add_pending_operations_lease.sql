-- BOTS-9 review finding (BLOCKER-2): the outbox's claim previously trusted
-- a row's `status = 'in_progress'` at face value and executed it directly
-- when found that way — with no owner identity and no expiry, two workers
-- (a live one and a recovery pass, or two recovery passes) could both
-- believe they owned the same row and both call Telegram. `worker_id` +
-- `lease_expires_at` make the claim itself the single point of truth: a
-- row is only ever actionable once *this* worker has atomically won it,
-- and only reclaimable by someone else once the lease has genuinely
-- expired — not merely because the status still says `in_progress`.
ALTER TABLE "moderation"."pending_operations" ADD COLUMN "worker_id" text;
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "pending_operations_lease_idx" ON "moderation"."pending_operations" USING btree ("status","lease_expires_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    GRANT UPDATE (worker_id, lease_expires_at) ON moderation.pending_operations TO telegram_bot;
  END IF;
END $$;

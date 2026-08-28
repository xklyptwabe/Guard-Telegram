ALTER TABLE "audit"."events"
  DROP CONSTRAINT "events_status_check";
--> statement-breakpoint
ALTER TABLE "audit"."events"
  ADD CONSTRAINT "events_status_check"
  CHECK ("status" IN ('recorded', 'failed', 'unknown'));

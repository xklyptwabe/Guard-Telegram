-- BOTS-9 follow-up:
-- 1) Do not let raw SQL insert unknown event types (FK events → event_types).
-- 2) DB-level CHECK for remaining audit state machines.
-- 3) Index for consumed_envelopes retention (dedup horizon).
ALTER TABLE "audit"."events"
  ADD CONSTRAINT "events_event_type_version_event_types_fk"
  FOREIGN KEY ("event_type", "event_version")
  REFERENCES "audit"."event_types"("event_type", "event_version")
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "audit"."events"
  ADD CONSTRAINT "events_status_check"
  CHECK ("status" IN ('recorded', 'failed'));
--> statement-breakpoint
ALTER TABLE "audit"."outbox"
  ADD CONSTRAINT "outbox_status_check"
  CHECK ("status" IN ('pending', 'delivered', 'failed'));
--> statement-breakpoint
ALTER TABLE "audit"."entity_snapshots"
  ADD CONSTRAINT "entity_snapshots_status_check"
  CHECK ("snapshot_status" IN ('current', 'archived'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consumed_envelopes_consumed_at_idx"
  ON "core"."consumed_envelopes" ("consumed_at");

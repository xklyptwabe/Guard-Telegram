-- Audit outbox payloads are self-contained delivery envelopes. Retention may
-- remove an expired event without discarding unfinished delivery debt; the
-- foreign key is cleared for pending/failed rows, while the retention query
-- explicitly removes already-delivered rows.
ALTER TABLE "audit"."outbox"
  DROP CONSTRAINT "outbox_event_id_events_id_fk";
--> statement-breakpoint
ALTER TABLE "audit"."outbox"
  ALTER COLUMN "event_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit"."outbox"
  ADD CONSTRAINT "outbox_event_id_events_id_fk"
  FOREIGN KEY ("event_id") REFERENCES "audit"."events"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

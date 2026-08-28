-- Retention deletes audit.events while unfinished delivery envelopes survive
-- through ON DELETE SET NULL. Index the referencing column so PostgreSQL can
-- find affected outbox rows without scanning the whole delivery table.
CREATE INDEX IF NOT EXISTS "outbox_event_idx"
  ON "audit"."outbox" USING btree ("event_id");

-- BOTS-7: an absent snapshot is data, not an empty JSON document. Keep the
-- row used for per-subject locking and sequence allocation, but represent
-- "never observed" explicitly as SQL NULL.
ALTER TABLE "audit"."entity_snapshots"
  ALTER COLUMN "snapshot_data" DROP NOT NULL;
--> statement-breakpoint
UPDATE "audit"."entity_snapshots" AS snapshot
SET "snapshot_data" = NULL,
    "updated_at" = now()
WHERE snapshot."snapshot_data" = '{}'::jsonb;

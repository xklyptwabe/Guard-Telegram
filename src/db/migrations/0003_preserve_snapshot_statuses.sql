ALTER TABLE "audit"."events" ADD COLUMN "before_snapshot_status" text DEFAULT 'not_observed' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit"."events" ADD COLUMN "after_snapshot_status" text DEFAULT 'observed' NOT NULL;

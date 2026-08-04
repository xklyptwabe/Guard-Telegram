ALTER TABLE "audit"."event_types" ADD COLUMN "severity" text DEFAULT 'info' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit"."event_types" ADD COLUMN "site_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "audit"."event_types" ADD COLUMN "can_be_disabled" boolean DEFAULT true NOT NULL;

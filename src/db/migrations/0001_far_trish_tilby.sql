CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "audit"."entity_snapshots" (
	"tenant_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"snapshot_status" text DEFAULT 'current' NOT NULL,
	"snapshot_data" jsonb NOT NULL,
	"last_subject_sequence" timestamp NOT NULL,
	"last_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_snapshots_tenant_id_entity_type_entity_id_pk" PRIMARY KEY("tenant_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "audit"."event_policies" (
	"event_type" text NOT NULL,
	"event_version" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"retention_days" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_policies_event_type_event_version_pk" PRIMARY KEY("event_type","event_version")
);
--> statement-breakpoint
CREATE TABLE "audit"."event_types" (
	"event_type" text NOT NULL,
	"event_version" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_types_event_type_event_version_pk" PRIMARY KEY("event_type","event_version")
);
--> statement-breakpoint
CREATE TABLE "audit"."events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"event_version" text NOT NULL,
	"category" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'recorded' NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_id" text,
	"actor_type" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_sequence" timestamp NOT NULL,
	"correlation_id" text,
	"telegram_context" jsonb,
	"idempotency_key" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changes" jsonb,
	"metadata" jsonb,
	CONSTRAINT "events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "audit"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit"."outbox" ADD CONSTRAINT "outbox_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "audit"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_tenant_occurred_idx" ON "audit"."events" USING btree ("tenant_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_subject_sequence_idx" ON "audit"."events" USING btree ("tenant_id","subject_type","subject_id","subject_sequence");--> statement-breakpoint
CREATE INDEX "events_correlation_idx" ON "audit"."events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "events_type_occurred_idx" ON "audit"."events" USING btree ("event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "outbox_status_next_attempt_idx" ON "audit"."outbox" USING btree ("status","next_attempt_at");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    GRANT USAGE ON SCHEMA audit TO telegram_bot;
    GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO telegram_bot;
    REVOKE UPDATE, DELETE ON audit.events FROM telegram_bot;
    -- outbox: only INSERT+SELECT at this stage
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "audit"."event_types" ("event_type", "event_version", "category", "description") VALUES
  ('module.state.changed', 'v1', 'module', 'Module enabled/disabled state changed');
--> statement-breakpoint
INSERT INTO "audit"."event_policies" ("event_type", "event_version", "required", "enabled") VALUES
  ('module.state.changed', 'v1', true, true);
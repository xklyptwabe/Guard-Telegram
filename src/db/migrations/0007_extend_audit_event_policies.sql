ALTER TABLE "audit"."event_policies"
  DROP CONSTRAINT IF EXISTS "event_policies_event_type_version_event_types_fk";
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ADD COLUMN IF NOT EXISTS "policy_id" text,
  ADD COLUMN IF NOT EXISTS "chat_id" text,
  ADD COLUMN IF NOT EXISTS "module_id" text,
  ADD COLUMN IF NOT EXISTS "site_visible" boolean,
  ADD COLUMN IF NOT EXISTS "snapshot_mode" text,
  ADD COLUMN IF NOT EXISTS "allowlist" jsonb,
  ADD COLUMN IF NOT EXISTS "masking" jsonb,
  ADD COLUMN IF NOT EXISTS "severity" text,
  ADD COLUMN IF NOT EXISTS "export_allowed" boolean;
--> statement-breakpoint
UPDATE "audit"."event_policies"
SET "policy_id" = 'global:event:' || "event_type" || ':' || "event_version"
WHERE "policy_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ALTER COLUMN "policy_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  DROP CONSTRAINT IF EXISTS "event_policies_event_type_event_version_pk";
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ADD CONSTRAINT "event_policies_policy_id_pk" PRIMARY KEY ("policy_id");
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ALTER COLUMN "enabled" DROP DEFAULT,
  ALTER COLUMN "enabled" DROP NOT NULL,
  ALTER COLUMN "event_type" DROP NOT NULL,
  ALTER COLUMN "event_version" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ADD CONSTRAINT "event_policies_event_selector_check"
  CHECK (
    ("event_type" IS NULL AND "event_version" IS NULL)
    OR ("event_type" IS NOT NULL AND "event_version" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ADD CONSTRAINT "event_policies_single_target_check"
  CHECK (NOT ("event_type" IS NOT NULL AND "module_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ADD CONSTRAINT "event_policies_snapshot_mode_check"
  CHECK ("snapshot_mode" IS NULL OR "snapshot_mode" IN ('metadata', 'snapshot'));
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ADD CONSTRAINT "event_policies_severity_check"
  CHECK ("severity" IS NULL OR "severity" IN ('debug', 'info', 'notice', 'warning', 'critical'));
--> statement-breakpoint
ALTER TABLE "audit"."event_policies"
  ADD CONSTRAINT "event_policies_event_type_version_event_types_fk"
  FOREIGN KEY ("event_type", "event_version")
  REFERENCES "audit"."event_types"("event_type", "event_version")
  ON UPDATE cascade
  ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_policies_selector_unique_idx"
ON "audit"."event_policies" (
  COALESCE("chat_id", ''),
  COALESCE("event_type", ''),
  COALESCE("event_version", ''),
  COALESCE("module_id", '')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_policies_chat_idx"
ON "audit"."event_policies" ("chat_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_policies_event_type_idx"
ON "audit"."event_policies" ("event_type", "event_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_policies_module_idx"
ON "audit"."event_policies" ("module_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit"."enforce_event_policy_disable_rules"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  can_disable boolean;
BEGIN
  IF NEW."enabled" IS DISTINCT FROM false THEN
    RETURN NEW;
  END IF;

  IF NEW."event_type" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT event_type."can_be_disabled"
    INTO can_disable
  FROM "audit"."event_types" AS event_type
  WHERE event_type."event_type" = NEW."event_type"
    AND event_type."event_version" = NEW."event_version";

  IF can_disable IS NULL THEN
    RAISE EXCEPTION 'Audit event %.% is not registered', NEW."event_type", NEW."event_version"
      USING ERRCODE = '23503';
  END IF;

  IF can_disable = false THEN
    RAISE EXCEPTION 'Audit event %.% cannot be disabled', NEW."event_type", NEW."event_version"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

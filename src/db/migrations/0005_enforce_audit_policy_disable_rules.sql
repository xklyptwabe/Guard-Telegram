UPDATE "audit"."event_policies" AS policy
SET "enabled" = true,
    "updated_at" = now()
FROM "audit"."event_types" AS event_type
WHERE policy."event_type" = event_type."event_type"
  AND policy."event_version" = event_type."event_version"
  AND event_type."can_be_disabled" = false
  AND policy."enabled" = false;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit"."enforce_event_policy_disable_rules"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  can_disable boolean;
BEGIN
  IF NEW."enabled" = true THEN
    RETURN NEW;
  END IF;

  SELECT event_type."can_be_disabled"
    INTO can_disable
  FROM "audit"."event_types" AS event_type
  WHERE event_type."event_type" = NEW."event_type"
    AND event_type."event_version" = NEW."event_version";

  IF can_disable = false THEN
    RAISE EXCEPTION 'Audit event %.% cannot be disabled', NEW."event_type", NEW."event_version"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "event_policies_enforce_disable_rules" ON "audit"."event_policies";
--> statement-breakpoint
CREATE TRIGGER "event_policies_enforce_disable_rules"
BEFORE INSERT OR UPDATE OF "enabled", "event_type", "event_version"
ON "audit"."event_policies"
FOR EACH ROW
EXECUTE FUNCTION "audit"."enforce_event_policy_disable_rules"();

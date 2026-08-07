ALTER TABLE "audit"."event_policies"
  ADD CONSTRAINT "event_policies_event_type_version_event_types_fk"
  FOREIGN KEY ("event_type", "event_version")
  REFERENCES "audit"."event_types"("event_type", "event_version")
  ON UPDATE cascade
  ON DELETE restrict;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit"."enforce_event_policy_disable_rules"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  can_disable boolean;
BEGIN
  SELECT event_type."can_be_disabled"
    INTO can_disable
  FROM "audit"."event_types" AS event_type
  WHERE event_type."event_type" = NEW."event_type"
    AND event_type."event_version" = NEW."event_version";

  IF can_disable IS NULL THEN
    RAISE EXCEPTION 'Audit event %.% is not registered', NEW."event_type", NEW."event_version"
      USING ERRCODE = '23503';
  END IF;

  IF NEW."enabled" = true THEN
    RETURN NEW;
  END IF;

  IF can_disable = false THEN
    RAISE EXCEPTION 'Audit event %.% cannot be disabled', NEW."event_type", NEW."event_version"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

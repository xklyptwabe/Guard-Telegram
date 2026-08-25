-- Once a terminal external operation's audit is durably written (or an
-- effective policy deliberately skips it), the request/recovery/result
-- payloads are no longer needed. Keep only the row identity and outcome as
-- the durable idempotency tombstone.
CREATE OR REPLACE FUNCTION "moderation"."minimize_finalized_pending_operation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW."audit_status" IN ('written', 'policy_skipped')
     AND (
       NEW."status" IN ('succeeded', 'failed')
       OR (NEW."status" = 'unknown' AND NEW."next_attempt_at" IS NULL)
     ) THEN
    NEW."request_payload" := '{}'::jsonb;
    NEW."metadata" := '{}'::jsonb;
    NEW."result" := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "moderation"."minimize_finalized_pending_operation"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "pending_operations_minimize_finalized_payload"
BEFORE INSERT OR UPDATE ON "moderation"."pending_operations"
FOR EACH ROW
EXECUTE FUNCTION "moderation"."minimize_finalized_pending_operation"();
--> statement-breakpoint
UPDATE "moderation"."pending_operations"
SET "request_payload" = '{}'::jsonb,
    "metadata" = '{}'::jsonb,
    "result" = NULL
WHERE "audit_status" IN ('written', 'policy_skipped')
  AND (
    "status" IN ('succeeded', 'failed')
    OR ("status" = 'unknown' AND "next_attempt_at" IS NULL)
  );
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations"
  ADD CONSTRAINT "pending_operations_finalized_payload_minimized_check"
  CHECK (
    "audit_status" NOT IN ('written', 'policy_skipped')
    OR NOT (
      "status" IN ('succeeded', 'failed')
      OR ("status" = 'unknown' AND "next_attempt_at" IS NULL)
    )
    OR (
      "request_payload" = '{}'::jsonb
      AND COALESCE("metadata", '{}'::jsonb) = '{}'::jsonb
      AND "result" IS NULL
    )
  );

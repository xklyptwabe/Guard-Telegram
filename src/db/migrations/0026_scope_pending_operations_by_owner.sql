-- Every worker must only recover operations belonging to its own bot. An
-- unfinished pre-owner row cannot be assigned safely because the old schema
-- did not persist the bot identity separately for every operation kind.
-- Abort before changing the table instead of deploying bot-scoped workers
-- that would strand active execution or audit debt under `legacy`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "moderation"."pending_operations"
    WHERE "status" IN ('pending', 'in_progress')
       OR ("status" = 'unknown' AND "next_attempt_at" IS NOT NULL)
       OR "audit_status" = 'pending'
  ) THEN
    RAISE EXCEPTION 'Cannot scope pending operations by owner while unfinished execution or audit debt exists'
      USING ERRCODE = '55000',
            HINT = 'Keep the previous worker running until moderation.pending_operations is fully finalized, then retry the migration.';
  END IF;
END $$;
--> statement-breakpoint
-- Only finalized tombstones reach this point. Runtime may consult a matching
-- legacy tombstone on redelivery, preserving the old global idempotency
-- decision without making the row eligible for recovery.
ALTER TABLE "moderation"."pending_operations"
  ADD COLUMN "owner_id" text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations"
  ADD COLUMN "operation_fingerprint" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "moderation"."pending_operations_idempotency_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_operations_owner_idempotency_key_idx"
  ON "moderation"."pending_operations" USING btree ("owner_id", "idempotency_key");
--> statement-breakpoint
DROP INDEX IF EXISTS "moderation"."pending_operations_status_next_attempt_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "moderation"."pending_operations_lease_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "moderation"."pending_operations_chat_idx";
--> statement-breakpoint
CREATE INDEX "pending_operations_owner_status_next_attempt_idx"
  ON "moderation"."pending_operations" USING btree ("owner_id", "status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX "pending_operations_owner_lease_idx"
  ON "moderation"."pending_operations" USING btree ("owner_id", "status", "lease_expires_at");
--> statement-breakpoint
CREATE INDEX "pending_operations_owner_chat_idx"
  ON "moderation"."pending_operations" USING btree ("owner_id", "chat_id");

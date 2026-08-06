ALTER TABLE "audit"."event_policies"
  ADD COLUMN IF NOT EXISTS "lock_version" integer DEFAULT 1 NOT NULL;

-- BOTS-9 review finding (HIGH-4): migration 0013 created
-- "moderation"."pending_operations" but never granted the runtime
-- application role (telegram_bot) any privileges on it — confirmed via a
-- clean-DB reproduction that the role had no USAGE/SELECT/INSERT/UPDATE at
-- all. In production this would fail with "permission denied for schema
-- moderation" on the very first outbox write. Mirrors the exact
-- least-privilege pattern already used for the audit schema (migrations
-- 0001, 0011): SELECT+INSERT broadly, UPDATE restricted to only the
-- columns the application actually mutates after insert, no DELETE at all
-- (nothing in this codebase deletes pending_operations rows; a future
-- retention policy for this table is a separate, explicit decision, not an
-- accidental side effect of over-broad grants here).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    GRANT USAGE ON SCHEMA moderation TO telegram_bot;
    GRANT SELECT, INSERT ON moderation.pending_operations TO telegram_bot;
    GRANT UPDATE (
      status,
      attempt_count,
      last_attempt_at,
      next_attempt_at,
      result,
      updated_at
    ) ON moderation.pending_operations TO telegram_bot;
    -- kind / chat_id / request_payload / metadata / idempotency_key /
    -- created_at are set once at write-ahead time and never mutated
    -- afterward by any code path — no UPDATE grant for them.
    REVOKE DELETE ON moderation.pending_operations FROM telegram_bot;
  END IF;
END $$;

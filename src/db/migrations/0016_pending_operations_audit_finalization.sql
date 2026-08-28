-- BOTS-9 review findings (HIGH-3, MEDIUM-3):
--
-- HIGH-3: the audit record for a terminal external operation was written
-- best-effort by the caller and, if that write failed, nothing remembered
-- that the audit was still owed — the terminal operation's mandatory audit
-- trail was silently lost. `audit_status` makes audit-finalization itself a
-- durable state on the same row: 'pending' until the one-and-only audit
-- event has been written, 'written' after. A dedicated lease pair
-- (`audit_worker_id`/`audit_lease_expires_at`) lets the background worker
-- backfill failed audit writes with the same claim/CAS discipline the
-- operation itself uses — without disturbing the operation's own
-- `worker_id` lease columns (an audit backfill on a 'succeeded' row must
-- not look like an operation retry).
--
-- MEDIUM-3: the TypeScript enum on `status` protects nothing at the
-- database level — a direct write or an incompatible app version could put
-- arbitrary states in the table. The CHECKs below make the legal state
-- machine a DB invariant.
ALTER TABLE "moderation"."pending_operations" ADD COLUMN "audit_status" text NOT NULL DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations" ADD COLUMN "audit_worker_id" text;
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations" ADD COLUMN "audit_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations" ADD CONSTRAINT "pending_operations_status_check" CHECK ("status" IN ('pending', 'in_progress', 'succeeded', 'failed', 'unknown'));
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations" ADD CONSTRAINT "pending_operations_attempt_count_check" CHECK ("attempt_count" >= 0);
--> statement-breakpoint
-- Terminal states never schedule a retry; `resolve()` and an exhausted
-- `unknown` both null `next_attempt_at`.
ALTER TABLE "moderation"."pending_operations" ADD CONSTRAINT "pending_operations_terminal_next_attempt_check" CHECK ("status" NOT IN ('succeeded', 'failed') OR "next_attempt_at" IS NULL);
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations" ADD CONSTRAINT "pending_operations_audit_status_check" CHECK ("audit_status" IN ('pending', 'written'));
--> statement-breakpoint
-- An audit-finalization claim only ever applies to a row whose audit is
-- still owed.
ALTER TABLE "moderation"."pending_operations" ADD CONSTRAINT "pending_operations_audit_claim_check" CHECK ("audit_worker_id" IS NULL OR "audit_status" = 'pending');
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
    GRANT UPDATE (audit_status, audit_worker_id, audit_lease_expires_at) ON moderation.pending_operations TO telegram_bot;
  END IF;
END $$;

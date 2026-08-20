-- BOTS-9 review round-2 fix (BLOCKER-1): the terminal-audit finalizer
-- contract now distinguishes `recorded` from `policy_skipped`. When the
-- resolved audit policy deliberately disables the event (policy-driven
-- skip), the audit is no longer owed — retrying it forever would poison
-- the backfill pass. `audit_status` gains a third legal value so a
-- policy-skipped row is terminal for audit purposes, exactly like
-- `written`, while anything else that fails stays `pending` and retries.
ALTER TABLE "moderation"."pending_operations" DROP CONSTRAINT "pending_operations_audit_status_check";
--> statement-breakpoint
ALTER TABLE "moderation"."pending_operations" ADD CONSTRAINT "pending_operations_audit_status_check" CHECK ("audit_status" IN ('pending', 'written', 'policy_skipped'));

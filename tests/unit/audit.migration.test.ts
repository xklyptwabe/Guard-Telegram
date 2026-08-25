import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('audit migrations', () => {
  it('enforces event_policies registration through event_types', () => {
    const sql = readFileSync('src/db/migrations/0006_enforce_audit_policy_event_type_fk.sql', 'utf8');

    expect(sql).toContain('ADD CONSTRAINT "event_policies_event_type_version_event_types_fk"');
    expect(sql).toContain('REFERENCES "audit"."event_types"("event_type", "event_version")');
    expect(sql).toContain('IF can_disable IS NULL THEN');
    expect(sql).toContain("USING ERRCODE = '23503'");
  });

  it('extends event_policies', () => {
    const sql = readFileSync('src/db/migrations/0007_extend_audit_event_policies.sql', 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "policy_id" text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "site_visible" boolean');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "snapshot_mode" text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "allowlist" jsonb');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "masking" jsonb');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "severity" text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "export_allowed" boolean');
    expect(sql).toContain('ADD CONSTRAINT "event_policies_policy_id_pk" PRIMARY KEY ("policy_id")');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "event_policies_selector_unique_idx"');
  });

  it('adds lock versions for optimistic audit policy updates', () => {
    const sql = readFileSync('src/db/migrations/0008_add_audit_policy_lock_version.sql', 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "lock_version" integer DEFAULT 1 NOT NULL');
  });

  it('keeps protected event disable enforcement compatible with scoped policies', () => {
    const sql = readFileSync('src/db/migrations/0007_extend_audit_event_policies.sql', 'utf8');

    expect(sql).toContain('IF NEW."enabled" IS DISTINCT FROM false THEN');
    expect(sql).toContain('IF NEW."event_type" IS NULL THEN');
    expect(sql).toContain("RAISE EXCEPTION 'Audit event %.% cannot be disabled'");
    expect(sql).toContain("USING ERRCODE = '23514'");
  });

  it('grants only narrow audit retention permissions when the role exists', () => {
    const sql = readFileSync('src/db/migrations/0009_grant_audit_retention_role.sql', 'utf8');

    expect(sql).toContain("rolname = 'audit_retention'");
    expect(sql).toContain('GRANT USAGE ON SEQUENCE audit.subject_sequence TO audit_retention');
    expect(sql).toContain('GRANT SELECT, INSERT, DELETE ON audit.events TO audit_retention');
    expect(sql).toContain('GRANT SELECT, INSERT, DELETE ON audit.outbox TO audit_retention');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON audit.entity_snapshots TO audit_retention');
    expect(sql).toContain('REVOKE UPDATE ON audit.events FROM audit_retention');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON audit.event_policies FROM audit_retention');
  });

  it('indexes audit retention candidates for short batch scans', () => {
    const sql = readFileSync('src/db/migrations/0010_index_audit_retention_candidates.sql', 'utf8');

    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "events_retention_candidates_idx"');
    expect(sql).toContain('ON "audit"."events" ("occurred_at" ASC, "id" ASC)');
    expect(sql).toContain('WHERE "metadata" #>> \'{auditPolicy,values,retentionDays}\' ~ \'^[0-9]+$\'');
  });

  it('grants the application only the audit updates required by policy and snapshot services', () => {
    const sql = readFileSync('src/db/migrations/0011_grant_audit_application_updates.sql', 'utf8');

    expect(sql).toContain("rolname = 'telegram_bot'");
    expect(sql).toContain('ON audit.entity_snapshots TO telegram_bot');
    expect(sql).toContain('snapshot_status');
    expect(sql).toContain('last_subject_sequence');
    expect(sql).toContain('ON audit.event_policies TO telegram_bot');
    expect(sql).toContain('lock_version');
    expect(sql).toContain('REVOKE UPDATE, DELETE ON audit.events FROM telegram_bot');
    expect(sql).not.toMatch(/GRANT\s+UPDATE(?:\s*\([^)]*\))?\s+ON\s+audit\.events/i);
  });

  it('provisions the limited audit retention role without storing login credentials', () => {
    const sql = readFileSync('src/db/migrations/0012_ensure_audit_retention_role.sql', 'utf8');

    expect(sql).toContain('CREATE ROLE audit_retention');
    expect(sql).toContain('NOLOGIN');
    expect(sql).toContain('GRANT SELECT, INSERT, DELETE ON audit.events TO audit_retention');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON audit.entity_snapshots TO audit_retention');
    expect(sql).toContain('REVOKE UPDATE ON audit.events FROM audit_retention');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON audit.event_policies FROM audit_retention');
    expect(sql).not.toMatch(/PASSWORD/i);
  });

  it('adds events→event_types FK, audit status CHECKs, and consumed_envelopes horizon index', () => {
    const sql = readFileSync('src/db/migrations/0022_audit_integrity_and_dedup_horizon.sql', 'utf8');
    expect(sql).toContain('ADD CONSTRAINT "events_event_type_version_event_types_fk"');
    expect(sql).toContain('REFERENCES "audit"."event_types"("event_type", "event_version")');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain('ADD CONSTRAINT "events_status_check"');
    expect(sql).toContain("CHECK (\"status\" IN ('recorded', 'failed'))");
    expect(sql).toContain('ADD CONSTRAINT "outbox_status_check"');
    expect(sql).toContain("CHECK (\"status\" IN ('pending', 'delivered', 'failed'))");
    expect(sql).toContain('ADD CONSTRAINT "entity_snapshots_status_check"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "consumed_envelopes_consumed_at_idx"');
  });

  it('turns consumed_envelopes into a completed-only Rabbit consumer dedup state machine', () => {
    const sql = readFileSync('src/db/migrations/0023_consumed_envelope_state_machine.sql', 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT \'received\'');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "attempt_count" integer NOT NULL DEFAULT 0');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "worker_id" text');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone');
    expect(sql).toContain('ADD CONSTRAINT "consumed_envelopes_status_check"');
    expect(sql).toContain("CHECK (\"status\" IN ('received', 'processing', 'completed', 'failed'))");
    expect(sql).toContain('ADD CONSTRAINT "consumed_envelopes_worker_status_check"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "consumed_envelopes_status_lease_idx"');
    expect(sql).toContain('REVOKE UPDATE ON core.consumed_envelopes FROM telegram_bot');
    expect(sql).toContain('GRANT UPDATE (');
    expect(sql).not.toMatch(/GRANT\s+UPDATE\s+ON\s+core\.consumed_envelopes/i);
  });

  it('minimizes finalized external-operation payloads without broadening runtime UPDATE grants', () => {
    const sql = readFileSync('src/db/migrations/0024_minimize_finalized_pending_operations.sql', 'utf8');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION "moderation"."minimize_finalized_pending_operation"()');
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain('REVOKE ALL ON FUNCTION "moderation"."minimize_finalized_pending_operation"() FROM PUBLIC');
    expect(sql).toContain('CREATE TRIGGER "pending_operations_minimize_finalized_payload"');
    expect(sql).toContain('NEW."audit_status" IN (\'written\', \'policy_skipped\')');
    expect(sql).toContain('NEW."status" = \'unknown\' AND NEW."next_attempt_at" IS NULL');
    expect(sql).toContain('NEW."request_payload" := \'{}\'::jsonb');
    expect(sql).toContain('NEW."metadata" := \'{}\'::jsonb');
    expect(sql).toContain('NEW."result" := NULL');
    expect(sql).toContain('ADD CONSTRAINT "pending_operations_finalized_payload_minimized_check"');
    expect(sql).toContain('UPDATE "moderation"."pending_operations"');
    expect(sql).not.toMatch(/GRANT\s+UPDATE/i);
  });

  it('restores column-only UPDATE privileges for the external-operation outbox and Telegram inbox', () => {
    const sql = readFileSync('src/db/migrations/0020_least_privilege_inbox_outbox.sql', 'utf8');

    expect(sql).toContain('REVOKE UPDATE ON moderation.pending_operations FROM telegram_bot');
    expect(sql).toContain('REVOKE UPDATE ON core.processed_updates FROM telegram_bot');
    expect(sql).toContain('GRANT UPDATE (');
    expect(sql).toContain('audit_lease_expires_at');
    expect(sql).toContain('last_error');
    expect(sql).not.toMatch(/GRANT\s+UPDATE\s+ON\s+(?:moderation\.pending_operations|core\.processed_updates)/i);
  });
});

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
});

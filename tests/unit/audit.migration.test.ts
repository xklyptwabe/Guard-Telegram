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
});

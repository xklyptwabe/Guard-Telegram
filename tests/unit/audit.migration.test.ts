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
});

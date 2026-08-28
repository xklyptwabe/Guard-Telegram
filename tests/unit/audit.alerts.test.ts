import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const rules = readFileSync('monitoring/prometheus/audit-alerts.yml', 'utf8');

describe('audit alert rules', () => {
  it('alerts immediately when an audit database write fails', () => {
    expect(rules).toContain('alert: AuditMandatoryWriteFailed');
    expect(rules).toContain(
      'sum(increase(audit_events_rejected_total{status="write_failed"}[5m])) > 0',
    );
    expect(rules).toContain('for: 0m');
    expect(rules).toContain('severity: critical');
  });

  it('alerts on sustained growth aggregated by the bounded queue label', () => {
    expect(rules).toContain('alert: AuditOutboxBacklogGrowing');
    expect(rules).toContain('sum by (queue) (audit_outbox_pending)');
    expect(rules).toContain('audit_outbox_pending offset 15m');
    expect(rules).toContain('for: 5m');
  });

  it('does not propagate event types, statuses, or business identifiers into alert labels', () => {
    const labelBlocks = [...rules.matchAll(/labels:\n((?:\s{10}.+\n?)+)/g)].map((match) => match[1]).join('\n');

    expect(labelBlocks).not.toMatch(
      /event_type|status|chat_id|tenant_id|user_id|subject_id|correlation_id|idempotency/i,
    );
  });
});

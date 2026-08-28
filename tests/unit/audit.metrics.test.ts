import { describe, expect, it } from 'vitest';

import { outbox } from '../../src/db/schema/audit.js';
import { pendingOperations } from '../../src/db/schema/moderation.js';
import { AuditMetrics } from '../../src/lib/audit/metrics.js';

describe('audit metrics', () => {
  it('records committed, duplicate, rejected, and unknown outcomes with bounded labels', async () => {
    const metrics = new AuditMetrics({} as never);

    metrics.recordWrite('module.state.changed', 'recorded', false, 4);
    metrics.recordWrite('moderation.action', 'unknown', false, 12);
    metrics.recordWrite('module.state.changed', 'recorded', true, 2);
    metrics.recordRejection('user-controlled-event-type', 'validation_failed', 1);

    await expect(metrics.registry.getSingleMetricAsString('audit_events_written_total')).resolves.toContain(
      'audit_events_written_total{event_type="module.state.changed",status="recorded"} 1',
    );
    await expect(metrics.registry.getSingleMetricAsString('audit_duplicates_total')).resolves.toContain(
      'audit_duplicates_total{event_type="module.state.changed",status="recorded"} 1',
    );
    await expect(metrics.registry.getSingleMetricAsString('audit_events_rejected_total')).resolves.toContain(
      'audit_events_rejected_total{event_type="_unregistered",status="validation_failed"} 1',
    );
    await expect(metrics.registry.getSingleMetricAsString('audit_unknown_outcomes_total')).resolves.toContain(
      'audit_unknown_outcomes_total{event_type="moderation.action",status="unknown"} 1',
    );
    await expect(metrics.registry.getSingleMetricAsString('audit_events_rejected_total')).resolves.not.toContain(
      'user-controlled-event-type',
    );

    const duration = await metrics.registry.getSingleMetricAsString('audit_write_duration_ms');
    expect(duration).toContain('audit_write_duration_ms_count{event_type="module.state.changed",status="recorded"} 1');
    expect(duration).toContain('audit_write_duration_ms_count{event_type="module.state.changed",status="duplicate"} 1');
    expect(duration).toContain('audit_write_duration_ms_count{event_type="_unregistered",status="rejected"} 1');
  });

  it('collects both outbox models from the database without business identifiers', async () => {
    const metrics = new AuditMetrics(fakeOutboxMetricsDatabase() as never);
    const output = await metrics.registry.getSingleMetricAsString('audit_outbox_pending');

    expect(output).toContain('audit_outbox_pending{queue="audit_delivery",status="pending"} 3');
    expect(output).toContain('audit_outbox_pending{queue="audit_delivery",status="failed"} 1');
    expect(output).toContain('audit_outbox_pending{queue="external_operations",status="pending"} 2');
    expect(output).toContain('audit_outbox_pending{queue="external_operations",status="in_progress"} 1');
    expect(output).toContain('audit_outbox_pending{queue="external_operations",status="retry_scheduled"} 4');
    expect(output).toContain('audit_outbox_pending{queue="external_operations",status="audit_pending"} 5');
    expect(output).not.toMatch(/chat|tenant|subject|correlation|idempotency/);
  });

  it('tracks only recent database write failures for health', () => {
    const metrics = new AuditMetrics({} as never);
    metrics.recordRejection('module.state.changed', 'validation_failed', 1);
    expect(metrics.hasRecentWriteFailure()).toBe(false);

    metrics.recordRejection('module.state.changed', 'write_failed', 1);
    expect(metrics.hasRecentWriteFailure()).toBe(true);
    expect(metrics.hasRecentWriteFailure(Date.now() + 5 * 60 * 1_000 + 1)).toBe(false);
  });
});

function fakeOutboxMetricsDatabase() {
  return {
    select(selection: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const rows =
            table === outbox
              ? [
                  { status: 'pending', count: 3 },
                  { status: 'failed', count: 1 },
                ]
              : 'status' in selection
                ? [
                    { status: 'pending', count: 2 },
                    { status: 'in_progress', count: 1 },
                    { status: 'unknown', count: 4 },
                  ]
                : [{ count: 5 }];
          const query = {
            where() {
              return query;
            },
            groupBy() {
              return Promise.resolve(rows);
            },
            then(onFulfilled: (value: typeof rows) => unknown, onRejected?: (error: unknown) => unknown) {
              return Promise.resolve(rows).then(onFulfilled, onRejected);
            },
          };
          if (table !== outbox && table !== pendingOperations) throw new Error('Unexpected metrics table');
          return query;
        },
      };
    },
  };
}

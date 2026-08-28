import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

import type { DrizzleDatabase } from '../../db/client.js';
import type { AuditEventStatus } from './enums.js';
import { readAuditOperationalState, type AuditOperationalState } from './operationalState.js';
import { auditEventRegistry } from './registry.js';

export type AuditRejectionStatus =
  | 'policy_disabled'
  | 'validation_failed'
  | 'idempotency_conflict'
  | 'write_failed';

type AuditWriteDurationStatus = AuditEventStatus | 'duplicate' | 'rejected';

const writeDurationBucketsMs = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];
export const RECENT_AUDIT_WRITE_FAILURE_WINDOW_MS = 5 * 60 * 1_000;

export interface AuditMetricsRecorder {
  recordWrite(eventType: string, status: AuditEventStatus, duplicate: boolean, durationMs: number): void;
  recordRejection(eventType: string, status: AuditRejectionStatus, durationMs: number): void;
}

export class AuditMetrics implements AuditMetricsRecorder {
  public readonly registry = new Registry();
  private lastWriteFailureAt: number | undefined;

  private readonly eventsWritten = new Counter({
    name: 'audit_events_written_total',
    help: 'Audit events committed to the database.',
    labelNames: ['event_type', 'status'] as const,
    registers: [this.registry],
  });

  private readonly eventsRejected = new Counter({
    name: 'audit_events_rejected_total',
    help: 'Audit write attempts rejected before an event was committed.',
    labelNames: ['event_type', 'status'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'audit_duplicates_total',
    help: 'Idempotent audit writes resolved to an existing event.',
    labelNames: ['event_type', 'status'] as const,
    registers: [this.registry],
  });

  private readonly outboxPending: Gauge<'queue' | 'status'>;

  private readonly writeDuration = new Histogram({
    name: 'audit_write_duration_ms',
    help: 'Duration of audit write attempts in milliseconds.',
    labelNames: ['event_type', 'status'] as const,
    buckets: writeDurationBucketsMs,
    registers: [this.registry],
  });

  private readonly unknownOutcomes = new Counter({
    name: 'audit_unknown_outcomes_total',
    help: 'Terminal unknown outcomes committed as audit events.',
    labelNames: ['event_type', 'status'] as const,
    registers: [this.registry],
  });

  public constructor(private readonly db: DrizzleDatabase) {
    const database = this.db;
    this.outboxPending = new Gauge({
      name: 'audit_outbox_pending',
      help: 'Current unfinished audit delivery and external operation outbox rows.',
      labelNames: ['queue', 'status'] as const,
      registers: [this.registry],
      async collect() {
        const state = await readAuditOperationalState(database);
        collectOutboxPending(state, this);
      },
    });
  }

  public recordWrite(eventType: string, status: AuditEventStatus, duplicate: boolean, durationMs: number): void {
    const metricEventType = normalizeEventType(eventType);
    if (duplicate) {
      this.duplicates.inc({ event_type: metricEventType, status });
      this.observeWriteDuration(metricEventType, 'duplicate', durationMs);
      return;
    }

    this.eventsWritten.inc({ event_type: metricEventType, status });
    this.observeWriteDuration(metricEventType, status, durationMs);
    if (status === 'unknown') {
      this.unknownOutcomes.inc({ event_type: metricEventType, status: 'unknown' });
    }
  }

  public recordRejection(eventType: string, status: AuditRejectionStatus, durationMs: number): void {
    const metricEventType = normalizeEventType(eventType);
    this.eventsRejected.inc({ event_type: metricEventType, status });
    this.observeWriteDuration(metricEventType, 'rejected', durationMs);
    if (status === 'write_failed') this.lastWriteFailureAt = Date.now();
  }

  public readOperationalState(now = new Date()): Promise<AuditOperationalState> {
    return readAuditOperationalState(this.db, now);
  }

  public hasRecentWriteFailure(
    now = Date.now(),
    windowMs = RECENT_AUDIT_WRITE_FAILURE_WINDOW_MS,
  ): boolean {
    return this.lastWriteFailureAt !== undefined && now - this.lastWriteFailureAt <= windowMs;
  }

  private observeWriteDuration(eventType: string, status: AuditWriteDurationStatus, durationMs: number): void {
    this.writeDuration.observe({ event_type: eventType, status }, Math.max(durationMs, 0));
  }
}

function collectOutboxPending(state: AuditOperationalState, gauge: Gauge<'queue' | 'status'>): void {
  gauge.reset();
  gauge.set({ queue: 'audit_delivery', status: 'pending' }, state.delivery.pending);
  gauge.set({ queue: 'audit_delivery', status: 'failed' }, state.delivery.failed);
  gauge.set({ queue: 'external_operations', status: 'pending' }, state.externalOperations.pending);
  gauge.set({ queue: 'external_operations', status: 'in_progress' }, state.externalOperations.inProgress);
  gauge.set({ queue: 'external_operations', status: 'retry_scheduled' }, state.externalOperations.retryScheduled);
  gauge.set({ queue: 'external_operations', status: 'audit_pending' }, state.externalOperations.auditPending);
}

function normalizeEventType(eventType: string): string {
  return auditEventRegistry.has(eventType) ? eventType : '_unregistered';
}

import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../db/client.js';
import { outbox } from '../../db/schema/audit.js';
import { pendingOperations } from '../../db/schema/moderation.js';
import type { AuditEventStatus } from './enums.js';
import { auditEventRegistry } from './registry.js';

export type AuditRejectionStatus =
  | 'policy_disabled'
  | 'validation_failed'
  | 'idempotency_conflict'
  | 'write_failed';

type AuditWriteDurationStatus = AuditEventStatus | 'duplicate' | 'rejected';

const writeDurationBucketsMs = [1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

export interface AuditMetricsRecorder {
  recordWrite(eventType: string, status: AuditEventStatus, duplicate: boolean, durationMs: number): void;
  recordRejection(eventType: string, status: AuditRejectionStatus, durationMs: number): void;
}

export class AuditMetrics implements AuditMetricsRecorder {
  public readonly registry = new Registry();

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
        await collectOutboxPending(database, this);
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
  }

  private observeWriteDuration(eventType: string, status: AuditWriteDurationStatus, durationMs: number): void {
    this.writeDuration.observe({ event_type: eventType, status }, Math.max(durationMs, 0));
  }
}

async function collectOutboxPending(db: DrizzleDatabase, gauge: Gauge<'queue' | 'status'>): Promise<void> {
  const [deliveryRows, operationRows, auditDebtRows] = await Promise.all([
    db
      .select({ status: outbox.status, count: sql<number>`count(*)::int` })
      .from(outbox)
      .where(inArray(outbox.status, ['pending', 'failed']))
      .groupBy(outbox.status),
    db
      .select({ status: pendingOperations.status, count: sql<number>`count(*)::int` })
      .from(pendingOperations)
      .where(
        or(
          eq(pendingOperations.status, 'pending'),
          eq(pendingOperations.status, 'in_progress'),
          and(eq(pendingOperations.status, 'unknown'), isNotNull(pendingOperations.nextAttemptAt)),
        ),
      )
      .groupBy(pendingOperations.status),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingOperations)
      .where(
        and(
          eq(pendingOperations.auditStatus, 'pending'),
          or(
            inArray(pendingOperations.status, ['succeeded', 'failed']),
            and(eq(pendingOperations.status, 'unknown'), isNull(pendingOperations.nextAttemptAt)),
          ),
        ),
      ),
  ]);

  gauge.reset();
  for (const status of ['pending', 'failed'] as const) {
    gauge.set({ queue: 'audit_delivery', status }, deliveryRows.find((row) => row.status === status)?.count ?? 0);
  }
  for (const status of ['pending', 'in_progress', 'retry_scheduled'] as const) {
    const databaseStatus = status === 'retry_scheduled' ? 'unknown' : status;
    gauge.set(
      { queue: 'external_operations', status },
      operationRows.find((row) => row.status === databaseStatus)?.count ?? 0,
    );
  }
  gauge.set({ queue: 'external_operations', status: 'audit_pending' }, auditDebtRows[0]?.count ?? 0);
}

function normalizeEventType(eventType: string): string {
  return auditEventRegistry.has(eventType) ? eventType : '_unregistered';
}

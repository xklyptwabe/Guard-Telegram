import { bigint, boolean, foreignKey, index, integer, pgSchema, primaryKey, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();

export const auditSchema = pgSchema('audit');

export const eventTypes = auditSchema.table(
  'event_types',
  {
    eventType: text('event_type').notNull(),
    eventVersion: text('event_version').notNull(),
    category: text('category').notNull(),
    description: text('description'),
    // Static, per-event-type metadata projected from the BOTS-7 registry
    // (definitions.ts) — not per-occurrence data. Seeded once from the
    // registry, not written on every event row (see
    // scripts/seedAuditEventTypes.ts). Previously this lived nowhere in
    // the DB at all and was smuggled into events.metadata.bots7 per row.
    severity: text('severity', { enum: ['debug', 'info', 'notice', 'warning', 'critical'] }).notNull().default('info'),
    siteVisible: boolean('site_visible').notNull().default(true),
    // Whether an operator is *allowed* to turn this event type off via
    // event_policies.enabled. This column doesn't itself gate anything at
    // write time — it's a UI/ops-facing constraint on what's a legal value
    // for event_policies.enabled for this type, enforced administratively.
    canBeDisabled: boolean('can_be_disabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.eventType, table.eventVersion] })],
);

export const eventPolicies = auditSchema.table(
  'event_policies',
  {
    eventType: text('event_type').notNull(),
    eventVersion: text('event_version').notNull(),
    required: boolean('required').notNull().default(true),
    retentionDays: integer('retention_days'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.eventType, table.eventVersion] }),
    foreignKey({
      name: 'event_policies_event_type_version_event_types_fk',
      columns: [table.eventType, table.eventVersion],
      foreignColumns: [eventTypes.eventType, eventTypes.eventVersion],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const events = auditSchema.table(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventType: text('event_type').notNull(),
    eventVersion: text('event_version').notNull(),
    category: text('category').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    source: text('source').notNull(),
    status: text('status', { enum: ['recorded', 'failed'] }).notNull().default('recorded'),
    tenantId: text('tenant_id').notNull(),
    actorId: text('actor_id'),
    actorType: text('actor_type'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectSequence: bigint('subject_sequence', { mode: 'number' }).default(sql`nextval('audit.subject_sequence')`).notNull(),
    correlationId: text('correlation_id'),
    telegramContext: jsonb('telegram_context'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    before: jsonb('before'),
    after: jsonb('after'),
    beforeSnapshotStatus: text('before_snapshot_status', {
      enum: ['observed', 'not_observed', 'redacted', 'unknown', 'not_applicable'],
    })
      .notNull()
      .default('not_observed'),
    afterSnapshotStatus: text('after_snapshot_status', {
      enum: ['observed', 'not_observed', 'redacted', 'unknown', 'not_applicable'],
    })
      .notNull()
      .default('observed'),
    changes: jsonb('changes'),
    metadata: jsonb('metadata'),
  },
  (table) => [
    index('events_tenant_occurred_idx').on(table.tenantId, table.occurredAt.desc()),
    index('events_subject_sequence_idx').on(table.tenantId, table.subjectType, table.subjectId, table.subjectSequence),
    index('events_correlation_idx').on(table.correlationId),
    index('events_type_occurred_idx').on(table.eventType, table.occurredAt.desc()),
  ],
);

export const entitySnapshots = auditSchema.table(
  'entity_snapshots',
  {
    tenantId: text('tenant_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    snapshotStatus: text('snapshot_status', { enum: ['current', 'archived'] }).notNull().default('current'),
    snapshotData: jsonb('snapshot_data').notNull(),
    lastSubjectSequence: bigint('last_subject_sequence', { mode: 'number' }).notNull(),
    lastEventId: uuid('last_event_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.entityType, table.entityId] })],
);

export const outbox = auditSchema.table(
  'outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    destination: text('destination').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull().default('pending'),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('outbox_status_next_attempt_idx').on(table.status, table.nextAttemptAt)],
);
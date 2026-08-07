import { and, desc, eq, gte, inArray, lte, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../db/client.js';
import { events } from '../../db/schema/audit.js';
import type { EventCategory } from './enums.js';

export const AUDIT_EVENTS_DEFAULT_LIMIT = 50;
export const AUDIT_EVENTS_MAX_LIMIT = 100;

export type AuditEventStatus = 'recorded' | 'failed';

export interface AuditEventsReadScope {
  readonly systemAdmin: boolean;
  readonly allowedChatIds: readonly string[];
}

export interface AuditEventsReadFilters {
  readonly occurredFrom?: Date;
  readonly occurredTo?: Date;
  readonly chatIds?: readonly string[];
  readonly topicId?: string;
  readonly actorId?: string;
  readonly eventTypes?: readonly string[];
  readonly categories?: readonly EventCategory[];
  readonly moduleId?: string;
  readonly source?: string;
  readonly status?: AuditEventStatus;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly correlationId?: string;
}

export interface AuditEventsListInput {
  readonly scope: AuditEventsReadScope;
  readonly filters?: AuditEventsReadFilters;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AuditEventsCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

export interface AuditEventReadRow {
  readonly id: string;
  readonly eventType: string;
  readonly eventVersion: string;
  readonly category: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly source: string;
  readonly status: AuditEventStatus;
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly actorType: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectSequence: number;
  readonly correlationId: string | null;
  readonly telegramContext: unknown;
  readonly before: unknown;
  readonly after: unknown;
  readonly beforeSnapshotStatus: string;
  readonly afterSnapshotStatus: string;
  readonly changes: unknown;
  readonly metadata: unknown;
}

export interface AuditEventsPage {
  readonly items: readonly AuditEventReadRow[];
  readonly nextCursor?: string;
}

export class AuditEventsCursorError extends Error {
  public constructor() {
    super('Audit events cursor is invalid.');
    this.name = 'AuditEventsCursorError';
  }
}

type AuditEventsReader = Pick<DrizzleDatabase, 'select'>;

export async function listAuditEvents(
  db: AuditEventsReader,
  input: AuditEventsListInput,
): Promise<AuditEventsPage> {
  const limit = normalizeAuditEventsLimit(input.limit);
  const rows = await buildAuditEventsListQuery(db, input);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    ...(rows.length > limit && last !== undefined
      ? { nextCursor: encodeAuditEventsCursor({ occurredAt: last.occurredAt, id: last.id }) }
      : {}),
  };
}

export function buildAuditEventsListQuery(db: AuditEventsReader, input: AuditEventsListInput) {
  const limit = normalizeAuditEventsLimit(input.limit);
  const cursor = input.cursor === undefined ? undefined : decodeAuditEventsCursor(input.cursor);
  return db
    .select({
      id: events.id,
      eventType: events.eventType,
      eventVersion: events.eventVersion,
      category: events.category,
      occurredAt: events.occurredAt,
      recordedAt: events.recordedAt,
      source: events.source,
      status: events.status,
      tenantId: events.tenantId,
      actorId: events.actorId,
      actorType: events.actorType,
      subjectType: events.subjectType,
      subjectId: events.subjectId,
      subjectSequence: events.subjectSequence,
      correlationId: events.correlationId,
      telegramContext: events.telegramContext,
      before: events.before,
      after: events.after,
      beforeSnapshotStatus: events.beforeSnapshotStatus,
      afterSnapshotStatus: events.afterSnapshotStatus,
      changes: events.changes,
      metadata: events.metadata,
    })
    .from(events)
    .where(and(...auditEventsWhereConditions(input.scope, input.filters ?? {}, cursor)))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(limit + 1);
}

export function encodeAuditEventsCursor(cursor: AuditEventsCursor): string {
  return Buffer.from(JSON.stringify({ occurredAt: cursor.occurredAt.toISOString(), id: cursor.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeAuditEventsCursor(value: string): AuditEventsCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || typeof parsed.occurredAt !== 'string' || typeof parsed.id !== 'string') {
      throw new AuditEventsCursorError();
    }
    const occurredAt = new Date(parsed.occurredAt);
    if (Number.isNaN(occurredAt.getTime()) || parsed.id.length === 0) {
      throw new AuditEventsCursorError();
    }
    return { occurredAt, id: parsed.id };
  } catch {
    throw new AuditEventsCursorError();
  }
}

export function isAuditEventRowPastCursor(
  row: Pick<AuditEventReadRow, 'occurredAt' | 'id'>,
  cursor: AuditEventsCursor,
): boolean {
  const rowTime = row.occurredAt.getTime();
  const cursorTime = cursor.occurredAt.getTime();
  return rowTime < cursorTime || (rowTime === cursorTime && row.id < cursor.id);
}

function auditEventsWhereConditions(
  scope: AuditEventsReadScope,
  filters: AuditEventsReadFilters,
  cursor: AuditEventsCursor | undefined,
): SQL[] {
  const conditions: SQL[] = [];
  const scopedChatIds = scopedAuditChatIds(scope, filters.chatIds);
  if (scopedChatIds !== undefined) {
    conditions.push(scopedChatIds.length === 0 ? sql`FALSE` : oneOrMany(events.tenantId, scopedChatIds));
  }
  if (filters.occurredFrom !== undefined) conditions.push(gte(events.occurredAt, filters.occurredFrom));
  if (filters.occurredTo !== undefined) conditions.push(lte(events.occurredAt, filters.occurredTo));
  if (filters.topicId !== undefined) {
    conditions.push(
      or(
        jsonTextEquals(events.telegramContext, 'messageThreadId', filters.topicId),
        jsonTextEquals(events.telegramContext, 'message_thread_id', filters.topicId),
      )!,
    );
  }
  if (filters.actorId !== undefined) conditions.push(eq(events.actorId, filters.actorId));
  if (filters.eventTypes !== undefined) conditions.push(oneOrMany(events.eventType, uniqueNonEmpty(filters.eventTypes)));
  if (filters.categories !== undefined) conditions.push(oneOrMany(events.category, uniqueNonEmpty(filters.categories)));
  if (filters.moduleId !== undefined) {
    conditions.push(
      or(
        jsonTextEquals(events.metadata, 'moduleId', filters.moduleId),
        jsonTextEquals(events.before, 'moduleId', filters.moduleId),
        jsonTextEquals(events.after, 'moduleId', filters.moduleId),
      )!,
    );
  }
  if (filters.source !== undefined) conditions.push(eq(events.source, filters.source));
  if (filters.status !== undefined) conditions.push(eq(events.status, filters.status));
  if (filters.subjectType !== undefined) conditions.push(eq(events.subjectType, filters.subjectType));
  if (filters.subjectId !== undefined) conditions.push(eq(events.subjectId, filters.subjectId));
  if (filters.correlationId !== undefined) conditions.push(eq(events.correlationId, filters.correlationId));
  if (cursor !== undefined) {
    conditions.push(
      or(
        sql`${events.occurredAt} < ${cursor.occurredAt}::timestamptz`,
        and(eq(events.occurredAt, cursor.occurredAt), sql`${events.id} < ${cursor.id}::uuid`),
      )!,
    );
  }
  return conditions;
}

function scopedAuditChatIds(scope: AuditEventsReadScope, requestedChatIds: readonly string[] | undefined): readonly string[] | undefined {
  const requested = requestedChatIds === undefined ? undefined : uniqueNonEmpty(requestedChatIds);
  if (scope.systemAdmin) return requested;
  const allowed = new Set(uniqueNonEmpty(scope.allowedChatIds));
  if (requested !== undefined) return requested.filter((chatId) => allowed.has(chatId));
  return [...allowed];
}

type AuditEventTextColumn = typeof events.tenantId | typeof events.eventType | typeof events.category;

function oneOrMany(column: AuditEventTextColumn, values: readonly string[]): SQL {
  if (values.length === 0) return sql`FALSE`;
  if (values.length === 1) return eq(column, values[0]!);
  return inArray(column, values);
}

function jsonTextEquals(column: SQLWrapper, key: string, value: string): SQL {
  return sql`${column} #>> ${sql.raw(`'{${key}}'`)} = ${value}`;
}

function normalizeAuditEventsLimit(limit: number | undefined): number {
  if (limit === undefined) return AUDIT_EVENTS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Audit events limit must be a positive integer.');
  }
  return Math.min(limit, AUDIT_EVENTS_MAX_LIMIT);
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

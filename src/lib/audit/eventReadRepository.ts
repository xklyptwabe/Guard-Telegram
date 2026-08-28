import { and, asc, desc, eq, gte, inArray, lte, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';

import type { DrizzleDatabase } from '../../db/client.js';
import { eventPolicies, events, eventTypes } from '../../db/schema/audit.js';
import type { AuditEventStatus, EventCategory } from './enums.js';
import {
  readAuditPolicyResolutionRows,
  resolveEffectiveAuditPolicyFromRows,
  type AuditPolicyResolutionRow,
} from './policyResolution.js';
import { PLATFORM_TENANT_SENTINEL } from './serviceAdapter.js';

export const AUDIT_EVENTS_DEFAULT_LIMIT = 50;
export const AUDIT_EVENTS_MAX_LIMIT = 100;

export type { AuditEventStatus } from './enums.js';

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
  readonly siteVisibleOnly?: boolean;
}

export interface AuditEventsCursor {
  readonly occurredAt: string;
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

export interface AuditEventTypeReadRow {
  readonly eventType: string;
  readonly eventVersion: string;
  readonly category: string;
  readonly description: string | null;
  readonly severity: string;
  readonly siteVisible: boolean;
  readonly canBeDisabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AuditPolicyReadRow {
  readonly policyId: string;
  readonly chatId: string | null;
  readonly eventType: string | null;
  readonly eventVersion: string | null;
  readonly moduleId: string | null;
  readonly required: boolean;
  readonly retentionDays: number | null;
  readonly enabled: boolean | null;
  readonly siteVisible: boolean | null;
  readonly snapshotMode: string | null;
  readonly allowlist: unknown;
  readonly masking: unknown;
  readonly severity: string | null;
  readonly exportAllowed: boolean | null;
  readonly lockVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class AuditEventsCursorError extends Error {
  public constructor() {
    super('Audit events cursor is invalid.');
    this.name = 'AuditEventsCursorError';
  }
}

const auditEventsCursorSchema = z
  .object({
    occurredAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    id: z.string().uuid(),
  })
  .strict();

type AuditEventsReader = Pick<DrizzleDatabase, 'select'>;

export async function listAuditEvents(
  db: AuditEventsReader,
  input: AuditEventsListInput,
): Promise<AuditEventsPage> {
  const limit = normalizeAuditEventsLimit(input.limit);
  if (input.cursor !== undefined) decodeAuditEventsCursor(input.cursor);
  if (input.siteVisibleOnly === true) return listSiteVisibleAuditEvents(db, input, limit);

  const rows = await buildAuditEventsListQuery(db, input);
  return auditEventsPage(rows, limit);
}

export async function getAuditEventById(
  db: AuditEventsReader,
  input: { readonly id: string; readonly scope: AuditEventsReadScope; readonly siteVisibleOnly?: boolean },
): Promise<AuditEventReadRow | undefined> {
  const rows = await buildAuditEventByIdQuery(db, input);
  const event = rows[0];
  if (event === undefined || input.siteVisibleOnly !== true) return event;

  const policies = await readAuditPolicyResolutionRows(db);
  return isEventSiteVisible(event, policies, new Map()) ? event : undefined;
}

export async function listAuditEventTypes(db: AuditEventsReader): Promise<readonly AuditEventTypeReadRow[]> {
  return db
    .select({
      eventType: eventTypes.eventType,
      eventVersion: eventTypes.eventVersion,
      category: eventTypes.category,
      description: eventTypes.description,
      severity: eventTypes.severity,
      siteVisible: eventTypes.siteVisible,
      canBeDisabled: eventTypes.canBeDisabled,
      createdAt: eventTypes.createdAt,
      updatedAt: eventTypes.updatedAt,
    })
    .from(eventTypes)
    .orderBy(asc(eventTypes.category), asc(eventTypes.eventType), asc(eventTypes.eventVersion));
}

export async function listAuditPolicies(
  db: AuditEventsReader,
  scope: AuditEventsReadScope,
): Promise<readonly AuditPolicyReadRow[]> {
  return buildAuditPoliciesListQuery(db, scope);
}

export async function getAuditPolicyById(
  db: AuditEventsReader,
  input: { readonly policyId: string; readonly scope: AuditEventsReadScope },
): Promise<AuditPolicyReadRow | undefined> {
  const rows = await buildAuditPolicyByIdQuery(db, input);
  return rows[0];
}

export function buildAuditEventByIdQuery(
  db: AuditEventsReader,
  input: { readonly id: string; readonly scope: AuditEventsReadScope },
) {
  return db
    .select(auditEventSelection)
    .from(events)
    .where(and(eq(events.id, input.id), ...auditEventScopeConditions(input.scope)))
    .limit(1);
}

export function buildAuditPolicyByIdQuery(
  db: AuditEventsReader,
  input: { readonly policyId: string; readonly scope: AuditEventsReadScope },
) {
  return db
    .select(auditPolicySelection)
    .from(eventPolicies)
    .where(and(eq(eventPolicies.policyId, input.policyId), ...auditPolicyScopeConditions(input.scope)))
    .limit(1);
}

export function buildAuditPoliciesListQuery(db: AuditEventsReader, scope: AuditEventsReadScope) {
  return db
    .select(auditPolicySelection)
    .from(eventPolicies)
    .where(and(...auditPolicyScopeConditions(scope)))
    .orderBy(asc(eventPolicies.chatId), asc(eventPolicies.eventType), asc(eventPolicies.moduleId), asc(eventPolicies.policyId));
}

export function buildAuditEventsListQuery(db: AuditEventsReader, input: AuditEventsListInput) {
  const limit = normalizeAuditEventsLimit(input.limit);
  const cursor = input.cursor === undefined ? undefined : decodeAuditEventsCursor(input.cursor);
  return db
    .select({
      ...auditEventSelection,
      cursorOccurredAt: sql<string>`${events.occurredAt}::text`,
    })
    .from(events)
    .where(and(...auditEventsWhereConditions(input.scope, input.filters ?? {}, cursor)))
    .orderBy(desc(events.occurredAt), desc(events.id))
    .limit(limit + 1);
}

const auditEventSelection = {
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
} as const;

const auditPolicySelection = {
  policyId: eventPolicies.policyId,
  chatId: eventPolicies.chatId,
  eventType: eventPolicies.eventType,
  eventVersion: eventPolicies.eventVersion,
  moduleId: eventPolicies.moduleId,
  required: eventPolicies.required,
  retentionDays: eventPolicies.retentionDays,
  enabled: eventPolicies.enabled,
  siteVisible: eventPolicies.siteVisible,
  snapshotMode: eventPolicies.snapshotMode,
  allowlist: eventPolicies.allowlist,
  masking: eventPolicies.masking,
  severity: eventPolicies.severity,
  exportAllowed: eventPolicies.exportAllowed,
  lockVersion: eventPolicies.lockVersion,
  createdAt: eventPolicies.createdAt,
  updatedAt: eventPolicies.updatedAt,
} as const;

type AuditEventListRow = AuditEventReadRow & { readonly cursorOccurredAt: string };

async function listSiteVisibleAuditEvents(
  db: AuditEventsReader,
  input: AuditEventsListInput,
  limit: number,
): Promise<AuditEventsPage> {
  const policies = await readAuditPolicyResolutionRows(db);
  const visibilityCache = new Map<string, boolean>();
  const visibleRows: AuditEventListRow[] = [];
  let scanCursor = input.cursor;

  while (visibleRows.length <= limit) {
    const candidates = await buildAuditEventsListQuery(db, {
      ...input,
      limit: AUDIT_EVENTS_MAX_LIMIT,
      ...(scanCursor === undefined ? {} : { cursor: scanCursor }),
    });
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      if (isEventSiteVisible(candidate, policies, visibilityCache)) visibleRows.push(candidate);
      if (visibleRows.length > limit) break;
    }
    if (visibleRows.length > limit || candidates.length <= AUDIT_EVENTS_MAX_LIMIT) break;

    const lastCandidate = candidates.at(-1);
    if (lastCandidate === undefined) break;
    scanCursor = encodeAuditEventsCursor({
      occurredAt: lastCandidate.cursorOccurredAt,
      id: lastCandidate.id,
    });
  }

  return auditEventsPage(visibleRows, limit);
}

function auditEventsPage(rows: readonly AuditEventListRow[], limit: number): AuditEventsPage {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toAuditEventReadRow),
    ...(rows.length > limit && last !== undefined
      ? { nextCursor: encodeAuditEventsCursor({ occurredAt: last.cursorOccurredAt, id: last.id }) }
      : {}),
  };
}

function isEventSiteVisible(
  event: AuditEventReadRow,
  policies: readonly AuditPolicyResolutionRow[],
  cache: Map<string, boolean>,
): boolean {
  const moduleId = eventModuleId(event);
  if (moduleId === null) return false;

  const key = [event.tenantId, event.eventType, event.eventVersion, moduleId ?? ''].join('\0');
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const effective = resolveEffectiveAuditPolicyFromRows(policies, {
    chatId: event.tenantId,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    ...(moduleId === undefined ? {} : { moduleId }),
  });
  cache.set(key, effective.values.siteVisible);
  return effective.values.siteVisible;
}

function eventModuleId(event: AuditEventReadRow): string | undefined | null {
  const moduleIds = new Set(
    [
      stringField(event.metadata, 'moduleId'),
      stringField(event.before, 'moduleId'),
      stringField(event.after, 'moduleId'),
    ].filter((moduleId): moduleId is string => moduleId !== undefined),
  );
  if (moduleIds.size > 1) return null;
  return moduleIds.values().next().value;
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export function encodeAuditEventsCursor(cursor: AuditEventsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeAuditEventsCursor(value: string): AuditEventsCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return auditEventsCursorSchema.parse(parsed);
  } catch {
    throw new AuditEventsCursorError();
  }
}

function auditEventsWhereConditions(
  scope: AuditEventsReadScope,
  filters: AuditEventsReadFilters,
  cursor: AuditEventsCursor | undefined,
): SQL[] {
  const conditions: SQL[] = [...auditEventScopeConditions(scope, filters.chatIds)];
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
      sql`(${events.occurredAt}, ${events.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  return conditions;
}

function auditEventScopeConditions(scope: AuditEventsReadScope, requestedChatIds?: readonly string[]): SQL[] {
  const scopedChatIds = scopedAuditChatIds(scope, requestedChatIds);
  if (scopedChatIds === undefined) return [];
  return [scopedChatIds.length === 0 ? sql`FALSE` : oneOrMany(events.tenantId, scopedChatIds)];
}

function auditPolicyScopeConditions(scope: AuditEventsReadScope): SQL[] {
  if (scope.systemAdmin) return [];
  const chatIds = nonPlatformChatIds(scope.allowedChatIds);
  return [chatIds.length === 0 ? sql`FALSE` : oneOrMany(eventPolicies.chatId, chatIds)];
}

function scopedAuditChatIds(scope: AuditEventsReadScope, requestedChatIds: readonly string[] | undefined): readonly string[] | undefined {
  const requested = requestedChatIds === undefined ? undefined : uniqueNonEmpty(requestedChatIds);
  if (scope.systemAdmin) return requested;
  const allowed = new Set(nonPlatformChatIds(scope.allowedChatIds));
  if (requested !== undefined) return requested.filter((chatId) => allowed.has(chatId));
  return [...allowed];
}

function nonPlatformChatIds(chatIds: readonly string[]): readonly string[] {
  return uniqueNonEmpty(chatIds).filter((chatId) => chatId !== PLATFORM_TENANT_SENTINEL);
}

type AuditEventTextColumn =
  | typeof events.tenantId
  | typeof events.eventType
  | typeof events.category
  | typeof eventPolicies.chatId;

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

function toAuditEventReadRow(
  row: AuditEventListRow,
): AuditEventReadRow {
  const event = { ...row };
  Reflect.deleteProperty(event, 'cursorOccurredAt');
  return event;
}

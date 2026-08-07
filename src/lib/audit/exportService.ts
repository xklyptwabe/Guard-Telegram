import { randomUUID } from 'node:crypto';

import type { DrizzleDatabase } from '../../db/client.js';
import type { AuditService } from '../auditService.js';
import {
  AUDIT_EVENTS_DEFAULT_LIMIT,
  AUDIT_EVENTS_MAX_LIMIT,
  listAuditEvents,
  type AuditEventReadRow,
  type AuditEventsReadFilters,
  type AuditEventsReadScope,
} from './eventReadRepository.js';
import { resolveEffectiveAuditPolicy } from './policyResolution.js';
import { PLATFORM_TENANT_SENTINEL } from './serviceAdapter.js';

export type AuditExportFormat = 'json' | 'csv';

export interface CreateAuditExportInput {
  readonly scope: AuditEventsReadScope;
  readonly filters: AuditEventsReadFilters;
  readonly format: AuditExportFormat;
  readonly requestedBy: string;
  readonly limit?: number;
}

export interface AuditExportResult {
  readonly exportId: string;
  readonly format: AuditExportFormat;
  readonly contentType: string;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly data: string | readonly Record<string, unknown>[];
  readonly auditEventId: string;
}

type AuditExportDatabase = Pick<DrizzleDatabase, 'select'>;

export class AuditExportPolicyError extends Error {
  public constructor() {
    super('Audit export is not allowed by policy.');
    this.name = 'AuditExportPolicyError';
  }
}

export async function createAuditExport(
  db: AuditExportDatabase,
  audit: AuditService,
  input: CreateAuditExportInput,
): Promise<AuditExportResult> {
  const limit = normalizeExportLimit(input.limit);
  const page = await listAuditEvents(db, {
    scope: input.scope,
    filters: input.filters,
    limit,
  });
  const rows = [...page.items];

  await assertExportAllowed(db, rows);

  const exportId = randomUUID();
  const serializedRows = rows.map(serializeEventForExport);
  const exported = input.format === 'csv' ? csvExport(serializedRows) : serializedRows;
  const auditSnapshot = auditExportSnapshot(exportId, input, rows);
  const auditResult = await audit.recordEntityChange(
    {
      tenantId: PLATFORM_TENANT_SENTINEL,
      subjectType: 'audit_export',
      subjectId: exportId,
      eventType: 'audit.exported',
      eventVersion: 'v1',
      category: 'audit',
      source: 'backend.api.audit.export',
      actorId: input.requestedBy,
      idempotencyKey: `backend-api:audit-export:${exportId}`,
      metadata: {
        operation: 'export',
        truncated: page.nextCursor !== undefined,
      },
    },
    () => Promise.resolve({
      before: undefined,
      after: auditSnapshot,
      beforeSnapshotStatus: 'not_applicable',
      afterSnapshotStatus: 'observed',
      snapshotData: auditSnapshot,
    }),
  );

  return {
    exportId,
    format: input.format,
    contentType: input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
    rowCount: rows.length,
    truncated: page.nextCursor !== undefined,
    data: exported,
    auditEventId: auditResult.eventId,
  };
}

function normalizeExportLimit(limit: number | undefined): number {
  if (limit === undefined) return AUDIT_EVENTS_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Audit export limit must be a positive integer.');
  }
  return Math.min(limit, AUDIT_EVENTS_MAX_LIMIT);
}

async function assertExportAllowed(db: AuditExportDatabase, rows: readonly AuditEventReadRow[]): Promise<void> {
  const cache = new Map<string, boolean>();

  for (const row of rows) {
    const moduleId = moduleIdFor(row);
    const cacheKey = [row.tenantId, row.eventType, row.eventVersion, moduleId ?? ''].join('\0');
    const cached = cache.get(cacheKey);
    if (cached === false) throw new AuditExportPolicyError();
    if (cached === true) continue;

    const policy = await resolveEffectiveAuditPolicy(db, {
      chatId: row.tenantId,
      eventType: row.eventType,
      eventVersion: row.eventVersion,
      ...(moduleId === undefined ? {} : { moduleId }),
    });
    cache.set(cacheKey, policy.values.exportAllowed);
    if (!policy.values.exportAllowed) throw new AuditExportPolicyError();
  }
}

function auditExportSnapshot(
  exportId: string,
  input: CreateAuditExportInput,
  rows: readonly AuditEventReadRow[],
): Record<string, unknown> {
  const range = exportRange(input.filters, rows);
  return {
    exportId,
    requestedBy: input.requestedBy,
    format: input.format,
    rangeFrom: range.from,
    rangeTo: range.to,
    rowCount: rows.length,
  };
}

function exportRange(
  filters: AuditEventsReadFilters,
  rows: readonly AuditEventReadRow[],
): { readonly from: string; readonly to: string } {
  const newest = rows[0]?.occurredAt;
  const oldest = rows.at(-1)?.occurredAt;
  const now = new Date().toISOString();
  return {
    from: (filters.occurredFrom ?? oldest)?.toISOString() ?? now,
    to: (filters.occurredTo ?? newest)?.toISOString() ?? now,
  };
}

function moduleIdFor(row: AuditEventReadRow): string | undefined {
  const moduleIds = new Set(
    [
      stringField(row.metadata, 'moduleId'),
      stringField(row.before, 'moduleId'),
      stringField(row.after, 'moduleId'),
    ].filter((moduleId): moduleId is string => moduleId !== undefined),
  );
  if (moduleIds.size > 1) throw new AuditExportPolicyError();
  return moduleIds.values().next().value;
}

function serializeEventForExport(row: AuditEventReadRow): Record<string, unknown> {
  return {
    ...row,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  };
}

const CSV_FIELDS = [
  'id',
  'eventType',
  'eventVersion',
  'category',
  'occurredAt',
  'recordedAt',
  'source',
  'status',
  'tenantId',
  'actorId',
  'actorType',
  'subjectType',
  'subjectId',
  'subjectSequence',
  'correlationId',
  'telegramContext',
  'before',
  'after',
  'beforeSnapshotStatus',
  'afterSnapshotStatus',
  'changes',
  'metadata',
] as const;

function csvExport(rows: readonly Record<string, unknown>[]): string {
  const header = CSV_FIELDS.join(',');
  const body = rows.map((row) => CSV_FIELDS.map((field) => csvCell(row[field])).join(','));
  return [header, ...body].join('\n');
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = csvText(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return '';
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const result = value[field];
  return typeof result === 'string' && result.length > 0 ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

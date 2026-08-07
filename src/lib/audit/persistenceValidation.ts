import type { SnapshotStatus } from './enums.js';
import { AuditSnapshotValidationError } from './errors.js';
import { applyAllowlist, stripForbidden, type AuditPolicyContext, type AllowlistField } from './masking.js';
import { auditEventRegistry, type AuditEventRegistry } from './registry.js';
import type { AuditEventDefinition } from './types.js';

const EVENT_VERSION_PATTERN = /^v(\d+)$/;
const DEFAULT_POLICY: AuditPolicyContext = { allowMessageTextLogging: false };

export interface AuditPersistenceEventInput {
  readonly eventType: string;
  readonly eventVersion: string;
  readonly category: string;
  readonly auditPolicy?: AuditPolicyContext;
}

export interface AuditPersistenceMutation {
  readonly before: Record<string, unknown> | undefined;
  readonly after: Record<string, unknown> | undefined;
  readonly beforeSnapshotStatus?: SnapshotStatus;
  readonly afterSnapshotStatus?: SnapshotStatus;
  readonly changes?: Record<string, unknown>;
  readonly snapshotData: Record<string, unknown>;
}

export interface NormalizedAuditPersistenceMutation {
  readonly before: Record<string, unknown> | undefined;
  readonly after: Record<string, unknown> | undefined;
  readonly beforeSnapshotStatus: SnapshotStatus;
  readonly afterSnapshotStatus: SnapshotStatus;
  readonly changes?: Record<string, unknown>;
  readonly snapshotData: Record<string, unknown>;
}

export function requireAuditPersistenceDefinition(
  input: AuditPersistenceEventInput,
  registry: AuditEventRegistry = auditEventRegistry,
): AuditEventDefinition<Record<string, unknown>> {
  const version = parseAuditEventVersion(input.eventVersion);
  const definition = registry.requireSupportedVersion(input.eventType, version);
  if (definition.category !== input.category) {
    throw new Error(
      `Audit event ${input.eventType}@${input.eventVersion} category mismatch: expected ${definition.category}, received ${input.category}`,
    );
  }
  return definition;
}

export function normalizeAuditMutationForPersistence(
  input: AuditPersistenceEventInput,
  mutation: AuditPersistenceMutation,
  definition: AuditEventDefinition<Record<string, unknown>> = requireAuditPersistenceDefinition(input),
): NormalizedAuditPersistenceMutation {
  const beforeSnapshotStatus = mutation.beforeSnapshotStatus ?? (mutation.before === undefined ? 'not_observed' : 'observed');
  const afterSnapshotStatus = mutation.afterSnapshotStatus ?? (mutation.after === undefined ? 'not_observed' : 'observed');
  const policy = input.auditPolicy ?? DEFAULT_POLICY;

  return {
    before: normalizeSnapshotSide(definition, policy, 'before', beforeSnapshotStatus, mutation.before),
    after: normalizeSnapshotSide(definition, policy, 'after', afterSnapshotStatus, mutation.after),
    beforeSnapshotStatus,
    afterSnapshotStatus,
    ...(mutation.changes === undefined ? {} : { changes: normalizeChanges(definition, policy, mutation.changes) }),
    snapshotData: normalizeSnapshotData(definition, policy, mutation.snapshotData),
  };
}

function parseAuditEventVersion(eventVersion: string): number {
  const match = EVENT_VERSION_PATTERN.exec(eventVersion);
  if (!match) throw new Error(`Audit event version must use v<number> format, received "${eventVersion}"`);
  return Number(match[1]);
}

function normalizeSnapshotSide(
  definition: AuditEventDefinition<Record<string, unknown>>,
  policy: AuditPolicyContext,
  side: 'before' | 'after',
  status: SnapshotStatus,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (status !== 'observed') return undefined;
  if (data === undefined) {
    throw new AuditSnapshotValidationError(definition.name, side, 'observed snapshot status requires snapshot data');
  }

  const schema = definition.sparseSnapshotSchema ?? definition.snapshotSchema;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AuditSnapshotValidationError(definition.name, side, result.error.message);
  }
  return applyAllowlist(result.data as Record<string, unknown>, definition.allowlist, policy);
}

function normalizeSnapshotData(
  definition: AuditEventDefinition<Record<string, unknown>>,
  policy: AuditPolicyContext,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const schema = definition.sparseSnapshotSchema ?? definition.snapshotSchema;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AuditSnapshotValidationError(definition.name, 'snapshotData', result.error.message);
  }
  return applyAllowlist(result.data as Record<string, unknown>, definition.allowlist, policy);
}

function normalizeChanges(
  definition: AuditEventDefinition<Record<string, unknown>>,
  policy: AuditPolicyContext,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = stripForbidden(changes);
  const allowedFields = allowedFieldNames(definition.allowlist, policy);
  const fields = stripped.fields;
  if (isRecord(fields)) {
    return { ...stripped, fields: filterChangeFields(fields, allowedFields) };
  }
  if (typeof stripped.status === 'string') return stripped;
  return filterChangeFields(stripped, allowedFields);
}

function allowedFieldNames(
  allowlist: readonly AllowlistField<Record<string, unknown>>[],
  policy: AuditPolicyContext,
): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const entry of allowlist) {
    const field = typeof entry === 'object' ? entry.field : entry;
    const allowed = typeof entry === 'object' ? entry.when(policy) : true;
    if (allowed) fields.add(String(field));
  }
  return fields;
}

function filterChangeFields(
  fields: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (allowedFields.has(field)) result[field] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

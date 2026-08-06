import { and, eq, sql } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../db/client.js';
import { eventPolicies } from '../../db/schema/audit.js';
import type { AuditService } from '../auditService.js';
import type { EventSeverity } from './enums.js';
import type { AuditSnapshotMode } from './policyResolution.js';
import { auditEventRegistry } from './registry.js';
import { PLATFORM_TENANT_SENTINEL } from './serviceAdapter.js';

export class AuditPolicyOptimisticLockError extends Error {
  public constructor(policyId: string, expectedLockVersion: number) {
    super(`Audit policy ${policyId} was not at lock version ${expectedLockVersion}.`);
    this.name = 'AuditPolicyOptimisticLockError';
  }
}

export class ProtectedAuditPolicyDisableError extends Error {
  public constructor(eventType: string, eventVersion: string) {
    super(`Audit event ${eventType}@${eventVersion} cannot be disabled.`);
    this.name = 'ProtectedAuditPolicyDisableError';
  }
}

export interface AuditPolicyPatch {
  readonly enabled?: boolean | null;
  readonly siteVisible?: boolean | null;
  readonly snapshotMode?: AuditSnapshotMode | null;
  readonly allowlist?: readonly string[] | null;
  readonly masking?: readonly string[] | null;
  readonly retentionDays?: number | null;
  readonly severity?: EventSeverity | null;
  readonly exportAllowed?: boolean | null;
}

export interface UpdateAuditPolicyWithLockInput {
  readonly policyId: string;
  readonly expectedLockVersion: number;
  readonly patch: AuditPolicyPatch;
}

export interface UpdateAuditPolicyWithAuditInput extends UpdateAuditPolicyWithLockInput {
  readonly actorId?: string;
  readonly idempotencyKey: string;
}

export interface UpdatedAuditPolicy {
  readonly policyId: string;
  readonly lockVersion: number;
  readonly updatedAt: Date;
}

export interface AuditedPolicyUpdateResult extends UpdatedAuditPolicy {
  readonly auditEventId: string;
  readonly duplicate: boolean;
}

type AuditPolicyWriter = Pick<DrizzleDatabase, 'select' | 'update'>;

export async function updateAuditPolicyWithLock(
  db: AuditPolicyWriter,
  input: UpdateAuditPolicyWithLockInput,
): Promise<UpdatedAuditPolicy> {
  if (input.patch.enabled === false) {
    await assertPolicyCanBeDisabled(db, input.policyId);
  }

  const set = policyPatchToUpdateSet(input.patch);
  const updatedAt = new Date();
  const rows = await db
    .update(eventPolicies)
    .set({
      ...set,
      lockVersion: sql`${eventPolicies.lockVersion} + 1`,
      updatedAt,
    })
    .where(and(eq(eventPolicies.policyId, input.policyId), eq(eventPolicies.lockVersion, input.expectedLockVersion)))
    .returning({
      policyId: eventPolicies.policyId,
      lockVersion: eventPolicies.lockVersion,
      updatedAt: eventPolicies.updatedAt,
    });

  const row = rows[0];
  if (row === undefined) {
    throw new AuditPolicyOptimisticLockError(input.policyId, input.expectedLockVersion);
  }
  return row;
}

export async function updateAuditPolicyWithAudit(
  audit: AuditService,
  input: UpdateAuditPolicyWithAuditInput,
): Promise<AuditedPolicyUpdateResult> {
  let updatedPolicy: UpdatedAuditPolicy | undefined;
  let protectedDisableError: ProtectedAuditPolicyDisableError | undefined;
  const auditResult = await audit.recordEntityChange(
    {
      tenantId: PLATFORM_TENANT_SENTINEL,
      subjectType: 'audit_policy',
      subjectId: input.policyId,
      eventType: 'audit.policy.changed',
      eventVersion: 'v1',
      category: 'audit',
      source: 'audit.policy.store',
      idempotencyKey: input.idempotencyKey,
      ...(input.actorId !== undefined ? { actorId: input.actorId, actorType: 'telegram_user' } : {}),
      metadata: { operation: 'update' },
    },
    async (tx) => {
      const beforeRow = await selectPolicySnapshotForUpdate(tx, input.policyId);
      if (beforeRow === undefined || beforeRow.lockVersion !== input.expectedLockVersion) {
        throw new AuditPolicyOptimisticLockError(input.policyId, input.expectedLockVersion);
      }
      if (input.patch.enabled === false) {
        protectedDisableError = protectedPolicyDisableError(beforeRow);
        if (protectedDisableError !== undefined) {
          const attemptedRow = applyPatchToSnapshotRow(beforeRow, input.patch);
          return {
            before: policySnapshot(beforeRow),
            after: policySnapshot(attemptedRow),
            changes: {
              status: 'rejected',
              fields: policyPatchChanges(beforeRow, attemptedRow, input.patch),
            },
            metadata: { operation: 'failed', reason: 'protected_event_disable' },
            snapshotData: policySnapshot(beforeRow),
          };
        }
      }

      const updatedAt = new Date();
      const rows = await tx
        .update(eventPolicies)
        .set({
          ...policyPatchToUpdateSet(input.patch),
          lockVersion: sql`${eventPolicies.lockVersion} + 1`,
          updatedAt,
        })
        .where(and(eq(eventPolicies.policyId, input.policyId), eq(eventPolicies.lockVersion, input.expectedLockVersion)))
        .returning(policySnapshotSelection);

      const afterRow = rows[0];
      if (afterRow === undefined) {
        throw new AuditPolicyOptimisticLockError(input.policyId, input.expectedLockVersion);
      }

      updatedPolicy = { policyId: afterRow.policyId, lockVersion: afterRow.lockVersion, updatedAt: afterRow.updatedAt };
      return {
        before: policySnapshot(beforeRow),
        after: policySnapshot(afterRow),
        changes: {
          fields: {
            lockVersion: { before: beforeRow.lockVersion, after: afterRow.lockVersion },
            ...policyPatchChanges(beforeRow, afterRow, input.patch),
          },
        },
        metadata: { operation: 'update' },
        snapshotData: policySnapshot(afterRow),
      };
    },
  );

  if (protectedDisableError !== undefined) {
    throw protectedDisableError;
  }

  if (updatedPolicy === undefined) {
    return { policyId: input.policyId, lockVersion: auditResult.subjectSequence, updatedAt: new Date(0), auditEventId: auditResult.eventId, duplicate: true };
  }

  return { ...updatedPolicy, auditEventId: auditResult.eventId, duplicate: auditResult.duplicate };
}

async function assertPolicyCanBeDisabled(db: Pick<DrizzleDatabase, 'select'>, policyId: string): Promise<void> {
  const rows = await db
    .select({ eventType: eventPolicies.eventType, eventVersion: eventPolicies.eventVersion })
    .from(eventPolicies)
    .where(eq(eventPolicies.policyId, policyId))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.eventType === null || row.eventVersion === null) return;

  const definition = auditEventRegistry.requireSupportedVersion(row.eventType, parseEventVersion(row.eventVersion));
  if (!definition.canBeDisabled) {
    throw new ProtectedAuditPolicyDisableError(row.eventType, row.eventVersion);
  }
}

function protectedPolicyDisableError(row: AuditPolicySnapshotRow): ProtectedAuditPolicyDisableError | undefined {
  if (row.eventType === null || row.eventVersion === null) return;
  const definition = auditEventRegistry.requireSupportedVersion(row.eventType, parseEventVersion(row.eventVersion));
  if (!definition.canBeDisabled) {
    return new ProtectedAuditPolicyDisableError(row.eventType, row.eventVersion);
  }
  return undefined;
}

function parseEventVersion(eventVersion: string): number {
  const match = /^v(\d+)$/.exec(eventVersion);
  if (!match) throw new Error(`Audit event version must use v<number> format, received "${eventVersion}"`);
  return Number(match[1]);
}

function policyPatchToUpdateSet(patch: AuditPolicyPatch): Partial<typeof eventPolicies.$inferInsert> {
  return {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.siteVisible !== undefined ? { siteVisible: patch.siteVisible } : {}),
    ...(patch.snapshotMode !== undefined ? { snapshotMode: patch.snapshotMode } : {}),
    ...(patch.allowlist !== undefined ? { allowlist: patch.allowlist === null ? null : [...patch.allowlist] } : {}),
    ...(patch.masking !== undefined ? { masking: patch.masking === null ? null : [...patch.masking] } : {}),
    ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
    ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
    ...(patch.exportAllowed !== undefined ? { exportAllowed: patch.exportAllowed } : {}),
  };
}

const policySnapshotSelection = {
  policyId: eventPolicies.policyId,
  chatId: eventPolicies.chatId,
  eventType: eventPolicies.eventType,
  eventVersion: eventPolicies.eventVersion,
  moduleId: eventPolicies.moduleId,
  enabled: eventPolicies.enabled,
  siteVisible: eventPolicies.siteVisible,
  snapshotMode: eventPolicies.snapshotMode,
  allowlist: eventPolicies.allowlist,
  masking: eventPolicies.masking,
  retentionDays: eventPolicies.retentionDays,
  severity: eventPolicies.severity,
  exportAllowed: eventPolicies.exportAllowed,
  lockVersion: eventPolicies.lockVersion,
  updatedAt: eventPolicies.updatedAt,
} as const;

type AuditPolicySnapshotRow = {
  readonly policyId: string;
  readonly chatId: string | null;
  readonly eventType: string | null;
  readonly eventVersion: string | null;
  readonly moduleId: string | null;
  readonly enabled: boolean | null;
  readonly siteVisible: boolean | null;
  readonly snapshotMode: AuditSnapshotMode | null;
  readonly allowlist: unknown;
  readonly masking: unknown;
  readonly retentionDays: number | null;
  readonly severity: EventSeverity | null;
  readonly exportAllowed: boolean | null;
  readonly lockVersion: number;
  readonly updatedAt: Date;
};

async function selectPolicySnapshotForUpdate(
  db: Pick<DrizzleDatabase, 'select'>,
  policyId: string,
): Promise<AuditPolicySnapshotRow | undefined> {
  const rows = await db
    .select(policySnapshotSelection)
    .from(eventPolicies)
    .where(eq(eventPolicies.policyId, policyId))
    .limit(1)
    .for('update');
  return rows[0];
}

function policySnapshot(row: AuditPolicySnapshotRow): Record<string, unknown> {
  return {
    policyId: row.policyId,
    scope: row.chatId ?? 'global',
    targetType: policyTargetType(row),
    ...(row.chatId === null ? {} : { chatId: row.chatId }),
    ...(row.eventType === null ? {} : { eventType: row.eventType }),
    ...(row.eventVersion === null ? {} : { eventVersion: row.eventVersion }),
    ...(row.moduleId === null ? {} : { moduleId: row.moduleId }),
    enabled: row.enabled,
    siteVisible: row.siteVisible,
    snapshotMode: row.snapshotMode,
    allowlist: parseStringArray(row.allowlist),
    masking: parseStringArray(row.masking),
    retentionDays: row.retentionDays,
    severity: row.severity,
    exportAllowed: row.exportAllowed,
    lockVersion: row.lockVersion,
  };
}

function policyTargetType(row: Pick<AuditPolicySnapshotRow, 'chatId' | 'eventType' | 'moduleId'>): 'global' | 'chat' | 'event_type' | 'module' {
  if (row.eventType !== null) return 'event_type';
  if (row.moduleId !== null) return 'module';
  return row.chatId === null ? 'global' : 'chat';
}

function parseStringArray(value: unknown): readonly string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function policyPatchChanges(
  before: AuditPolicySnapshotRow,
  after: AuditPolicySnapshotRow,
  patch: AuditPolicyPatch,
): Record<string, { readonly before: unknown; readonly after: unknown }> {
  const changes: Record<string, { readonly before: unknown; readonly after: unknown }> = {};
  for (const key of Object.keys(patch) as (keyof AuditPolicyPatch)[]) {
    changes[key] = { before: snapshotField(before, key), after: snapshotField(after, key) };
  }
  return changes;
}

function snapshotField(row: AuditPolicySnapshotRow, key: keyof AuditPolicyPatch): unknown {
  if (key === 'allowlist') return parseStringArray(row.allowlist);
  if (key === 'masking') return parseStringArray(row.masking);
  return row[key];
}

function applyPatchToSnapshotRow(row: AuditPolicySnapshotRow, patch: AuditPolicyPatch): AuditPolicySnapshotRow {
  return {
    ...row,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.siteVisible !== undefined ? { siteVisible: patch.siteVisible } : {}),
    ...(patch.snapshotMode !== undefined ? { snapshotMode: patch.snapshotMode } : {}),
    ...(patch.allowlist !== undefined ? { allowlist: patch.allowlist === null ? null : [...patch.allowlist] } : {}),
    ...(patch.masking !== undefined ? { masking: patch.masking === null ? null : [...patch.masking] } : {}),
    ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
    ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
    ...(patch.exportAllowed !== undefined ? { exportAllowed: patch.exportAllowed } : {}),
  };
}

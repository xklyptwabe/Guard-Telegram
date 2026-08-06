import { and, eq, sql } from 'drizzle-orm';

import type { DrizzleDatabase } from '../../db/client.js';
import { eventPolicies } from '../../db/schema/audit.js';
import type { EventSeverity } from './enums.js';
import type { AuditSnapshotMode } from './policyResolution.js';
import { auditEventRegistry } from './registry.js';

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

export interface UpdatedAuditPolicy {
  readonly policyId: string;
  readonly lockVersion: number;
  readonly updatedAt: Date;
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

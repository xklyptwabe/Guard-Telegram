import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { DrizzleDatabase } from '../db/client.js';
import {
  getAuditPolicyById,
  type AuditEventsReadScope,
} from '../lib/audit/eventReadRepository.js';
import {
  AuditPolicyOptimisticLockError,
  ProtectedAuditPolicyDisableError,
  updateAuditPolicyWithAudit,
  type AuditPolicyPatch,
} from '../lib/audit/policyStore.js';
import type { AuditService } from '../lib/auditService.js';
import type { BackendApiPrincipal } from './access.js';
import { hasBackendApiPermission } from './access.js';
import { badRequest, conflict, forbidden, notFound, type ApiResponse } from './responses.js';

const patchablePolicyFields = [
  'enabled',
  'siteVisible',
  'snapshotMode',
  'allowlist',
  'masking',
  'retentionDays',
  'severity',
  'exportAllowed',
] as const;

const snapshotModeSchema = z.enum(['metadata', 'snapshot']);
const severitySchema = z.enum(['debug', 'info', 'notice', 'warning', 'critical']);
const policyPatchRequestSchema = z
  .object({
    expectedLockVersion: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(256),
    enabled: z.boolean().nullable().optional(),
    siteVisible: z.boolean().nullable().optional(),
    snapshotMode: snapshotModeSchema.nullable().optional(),
    allowlist: z.array(z.string().trim().min(1).max(256)).nullable().optional(),
    masking: z.array(z.string().trim().min(1).max(256)).nullable().optional(),
    retentionDays: z.number().int().positive().nullable().optional(),
    severity: severitySchema.nullable().optional(),
    exportAllowed: z.boolean().nullable().optional(),
  })
  .strict()
  .refine(
    (value) => patchablePolicyFields.some((field) => value[field] !== undefined),
    'At least one policy field must be provided.',
  );

type PolicyPatchRequest = z.infer<typeof policyPatchRequestSchema>;

export interface AuditPolicyApiDependencies {
  readonly db: DrizzleDatabase;
  readonly audit: AuditService;
}

export async function handleAuditPolicyWriteRequest(
  method: string | undefined,
  url: URL,
  body: unknown,
  principal: BackendApiPrincipal,
  deps: AuditPolicyApiDependencies,
): Promise<ApiResponse | undefined> {
  if (method !== 'PATCH') return undefined;

  const policyId = matchPolicyId(url.pathname);
  if (policyId === undefined) return undefined;
  if (!hasBackendApiPermission(principal, 'audit.policies.manage')) return forbidden();

  const parsed = policyPatchRequestSchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error.message);

  const scope = writeScope(principal);
  const policy = await getAuditPolicyById(deps.db, { policyId, scope });
  if (policy === undefined) return notFound();
  const patch = toPolicyPatch(parsed.data);

  try {
    const updated = await updateAuditPolicyWithAudit(deps.db, deps.audit, {
      policyId,
      expectedLockVersion: parsed.data.expectedLockVersion,
      patch,
      actorId: principal.actorId,
      idempotencyKey: policyUpdateIdempotencyKey(policyId, principal.actorId, parsed.data, patch),
    });
    return {
      statusCode: 200,
      body: {
        item: {
          ...updated,
          updatedAt: updated.updatedAt.toISOString(),
        },
      },
    };
  } catch (error: unknown) {
    if (error instanceof AuditPolicyOptimisticLockError) return conflict(error.message);
    if (error instanceof ProtectedAuditPolicyDisableError) return badRequest(error.message);
    throw error;
  }
}

function matchPolicyId(pathname: string): string | undefined {
  const prefix = '/api/v1/audit/policies/';
  if (!pathname.startsWith(prefix)) return undefined;
  const rawPolicyId = pathname.slice(prefix.length);
  if (rawPolicyId.length === 0 || rawPolicyId.includes('/')) return undefined;

  try {
    const policyId = decodeURIComponent(rawPolicyId).trim();
    return policyId.length === 0 ? undefined : policyId;
  } catch {
    return undefined;
  }
}

function writeScope(principal: BackendApiPrincipal): AuditEventsReadScope {
  return { systemAdmin: principal.systemAdmin, allowedChatIds: principal.allowedChatIds };
}

function policyUpdateIdempotencyKey(
  policyId: string,
  actorId: string,
  request: PolicyPatchRequest,
  patch: AuditPolicyPatch,
): string {
  const operation = JSON.stringify({
    clientKey: request.idempotencyKey,
    actorId,
    policyId,
    expectedLockVersion: request.expectedLockVersion,
    patch,
  });
  const digest = createHash('sha256').update(operation).digest('base64url');
  return `backend-api:audit-policy:${digest}`;
}

function toPolicyPatch(request: PolicyPatchRequest): AuditPolicyPatch {
  return {
    ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
    ...(request.siteVisible !== undefined ? { siteVisible: request.siteVisible } : {}),
    ...(request.snapshotMode !== undefined ? { snapshotMode: request.snapshotMode } : {}),
    ...(request.allowlist !== undefined ? { allowlist: request.allowlist } : {}),
    ...(request.masking !== undefined ? { masking: request.masking } : {}),
    ...(request.retentionDays !== undefined ? { retentionDays: request.retentionDays } : {}),
    ...(request.severity !== undefined ? { severity: request.severity } : {}),
    ...(request.exportAllowed !== undefined ? { exportAllowed: request.exportAllowed } : {}),
  };
}

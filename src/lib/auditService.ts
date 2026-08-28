import { and, eq } from 'drizzle-orm';

import { getUpdateContext } from './context.js';
import type { AuditEventStatus, SnapshotStatus } from './audit/enums.js';
import {
  AUDIT_OPERATIONAL_METADATA_ALLOWLIST,
  applyAllowlist,
  isForbiddenAuditString,
  type AuditPolicyContext,
} from './audit/masking.js';
import { resolveEffectiveAuditPolicy, type EffectiveAuditPolicy } from './audit/policyResolution.js';
import {
  AuditSnapshotValidationError,
  UnregisteredAuditEventError,
  UnsupportedAuditEventVersionError,
} from './audit/errors.js';
import type { AuditMetricsRecorder, AuditRejectionStatus } from './audit/metrics.js';
import {
  normalizeAuditMutationForPersistence,
  requireAuditPersistenceDefinition,
  type NormalizedAuditPersistenceMutation,
} from './audit/persistenceValidation.js';
import { auditEventRegistry } from './audit/registry.js';
import type { DrizzleDatabase } from '../db/client.js';
import { entitySnapshots, events, outbox } from '../db/schema/audit.js';

export interface AuditIdentity {
  readonly tenantId: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

export type AuditSnapshotStatus = SnapshotStatus;
export type AuditEntitySnapshotStatus = 'current' | 'archived';

export interface AuditEventInput extends AuditIdentity {
  readonly eventType: string;
  readonly eventVersion: string;
  readonly category: string;
  readonly source: string;
  readonly idempotencyKey: string;
  readonly status?: AuditEventStatus;
  readonly actorId?: string;
  readonly actorType?: string;
  readonly correlationId?: string;
  readonly telegramContext?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly moduleId?: string;
  readonly auditPolicy?: AuditPolicyContext;
}

export interface AuditChange<TSnapshot extends Record<string, unknown>> {
  readonly before: Record<string, unknown> | undefined;
  readonly after: Record<string, unknown> | undefined;
  readonly beforeSnapshotStatus?: AuditSnapshotStatus;
  readonly afterSnapshotStatus?: AuditSnapshotStatus;
  readonly changes?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly snapshotStatus?: AuditEntitySnapshotStatus;
  readonly snapshotData: TSnapshot | null;
}

export type AuditMutationResult<TSnapshot extends Record<string, unknown>> = AuditChange<TSnapshot>;

export type AuditTransaction = Pick<DrizzleDatabase, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export class AuditIdempotencyConflictError extends Error {
  public constructor() {
    super('Audit idempotency key is already associated with another operation.');
    this.name = 'AuditIdempotencyConflictError';
  }
}

/**
 * BOTS-9 review round-2 (BLOCKER-1): thrown when the resolved audit policy
 * deliberately disables the event. Finalizers must map this to
 * `{ status: 'policy_skipped' }` — the audit is *not* owed, the operation
 * row becomes terminal for audit purposes — while any other (infrastructure)
 * error keeps the audit owed and the outbox retries it.
 */
export class AuditPolicyDisabledError extends Error {
  public constructor(eventType: string, eventVersion: string) {
    super(`Audit policy is unavailable for ${eventType}@${eventVersion}`);
    this.name = 'AuditPolicyDisabledError';
  }
}

export class ForbiddenAuditValueError extends Error {
  public constructor(field: string) {
    super(`Audit field "${field}" contains forbidden credential data.`);
    this.name = 'ForbiddenAuditValueError';
  }
}

export class AuditService {
  public constructor(
    private readonly db: DrizzleDatabase,
    private readonly metrics?: AuditMetricsRecorder,
  ) {}

  /** Apply BOTS-8 masking to outbox metadata before it is persisted. */
  public async maskOutboxMetadata(input: {
    readonly tenantId: string;
    readonly eventType: string;
    readonly eventVersion: string;
    readonly moduleId?: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const policy = await resolveEffectiveAuditPolicy(this.db, {
      eventType: input.eventType,
      eventVersion: input.eventVersion,
      chatId: input.tenantId,
      ...(input.moduleId !== undefined ? { moduleId: input.moduleId } : {}),
    });
    const definition = requireAuditPersistenceDefinition({
      eventType: input.eventType,
      eventVersion: input.eventVersion,
      category: policyCategory(input.eventType, input.eventVersion),
    });
    return applyAllowlist(input.metadata, definition.allowlist, {
      allowMessageTextLogging: policy.values.allowlist.includes('text'),
      allowlist: policy.values.allowlist,
      ...(policy.values.masking.length > 0 ? { masking: policy.values.masking } : {}),
    });
  }

  /**
   * Persist the last observed subject snapshot without inventing an audit
   * event (no message.created in the registry). Used for ordinary `message`
   * updates so a later edit/delete has a real `before`.
   */
  public async observeCurrentSnapshot(input: {
    readonly tenantId: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly eventType: string;
    readonly eventVersion: string;
    readonly moduleId?: string;
    readonly snapshotData: Record<string, unknown>;
    readonly observedUpdateId: number;
  }): Promise<void> {
    const snapshotWhere = and(
      eq(entitySnapshots.tenantId, input.tenantId),
      eq(entitySnapshots.entityType, input.subjectType),
      eq(entitySnapshots.entityId, input.subjectId),
    );
    await this.db.transaction(async (tx) => {
      const policy = await resolveEffectiveAuditPolicy(tx, {
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        chatId: input.tenantId,
        ...(input.moduleId !== undefined ? { moduleId: input.moduleId } : {}),
      });
      if (!policy.values.enabled || policy.values.snapshotMode !== 'snapshot') return;
      const definition = requireAuditPersistenceDefinition({
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        category: 'message',
      });
      const schema = definition.sparseSnapshotSchema ?? definition.snapshotSchema;
      const parsed = schema.safeParse(input.snapshotData);
      if (!parsed.success) {
        throw new AuditSnapshotValidationError(definition.name, 'snapshotData', parsed.error.message);
      }
      const masked: Record<string, unknown> = applyAllowlist(
        parsed.data as Record<string, unknown>,
        definition.allowlist,
        {
          allowMessageTextLogging: policy.values.allowlist.includes('text'),
          allowlist: policy.values.allowlist,
          ...(policy.values.masking.length > 0 ? { masking: policy.values.masking } : {}),
        },
      );
      await tx
        .insert(entitySnapshots)
        .values({
          tenantId: input.tenantId,
          entityType: input.subjectType,
          entityId: input.subjectId,
          snapshotStatus: 'current',
          snapshotData: null,
          lastSubjectSequence: 0,
        })
        .onConflictDoNothing({ target: [entitySnapshots.tenantId, entitySnapshots.entityType, entitySnapshots.entityId] });
      const rows = await tx
        .select({ snapshotData: entitySnapshots.snapshotData })
        .from(entitySnapshots)
        .where(snapshotWhere)
        .limit(1)
        .for('update');
      const existing = rows[0]?.snapshotData as Record<string, unknown> | null | undefined;
      const existingId = typeof existing?.observedUpdateId === 'number' ? existing.observedUpdateId : undefined;
      if (existing && Object.keys(existing).length > 0 && existingId !== undefined && existingId >= input.observedUpdateId) {
        return;
      }
      await tx
        .update(entitySnapshots)
        .set({ snapshotStatus: 'current', snapshotData: masked, updatedAt: new Date() })
        .where(snapshotWhere);
    });
  }

  public async recordEntityChange<TSnapshot extends Record<string, unknown>>(
    input: AuditEventInput,
    mutate: (tx: AuditTransaction, nextSubjectSequence: number) => Promise<AuditMutationResult<TSnapshot>>,
  ): Promise<{ readonly eventId: string; readonly subjectSequence: number; readonly duplicate: boolean }> {
    const startedAt = performance.now();
    let mutationFailed = false;
    let result: { readonly eventId: string; readonly subjectSequence: number; readonly duplicate: boolean };
    try {
      result = await this.persistEntityChange(input, async (tx, nextSubjectSequence) => {
        try {
          return await mutate(tx, nextSubjectSequence);
        } catch (error: unknown) {
          mutationFailed = true;
          throw error;
        }
      });
    } catch (error: unknown) {
      if (!mutationFailed) {
        this.metrics?.recordRejection(input.eventType, auditRejectionStatus(error), performance.now() - startedAt);
      }
      throw error;
    }
    this.metrics?.recordWrite(input.eventType, input.status ?? 'recorded', result.duplicate, performance.now() - startedAt);
    return result;
  }

  private async persistEntityChange<TSnapshot extends Record<string, unknown>>(
    input: AuditEventInput,
    mutate: (tx: AuditTransaction, nextSubjectSequence: number) => Promise<AuditMutationResult<TSnapshot>>,
  ): Promise<{ readonly eventId: string; readonly subjectSequence: number; readonly duplicate: boolean }> {
    const context = getUpdateContext();
    const correlationId = input.correlationId ?? context?.correlationId;
    assertSafeAuditEnvelope(input, correlationId);
    const auditDefinition = requireAuditPersistenceDefinition(input);
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: events.id,
          subjectSequence: events.subjectSequence,
          tenantId: events.tenantId,
          eventType: events.eventType,
          eventVersion: events.eventVersion,
          category: events.category,
          source: events.source,
          status: events.status,
          actorId: events.actorId,
          actorType: events.actorType,
          subjectType: events.subjectType,
          subjectId: events.subjectId,
        })
        .from(events)
        .where(eq(events.idempotencyKey, input.idempotencyKey))
        .limit(1);
      const existingEvent = existing[0];
      if (existingEvent !== undefined) {
        if (!sameIdempotentOperation(existingEvent, input)) {
          throw new AuditIdempotencyConflictError();
        }
        return { eventId: existingEvent.id, subjectSequence: existingEvent.subjectSequence, duplicate: true };
      }

      const effectivePolicy = await resolveEffectiveAuditPolicy(tx, {
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        chatId: input.tenantId,
        ...(input.moduleId !== undefined ? { moduleId: input.moduleId } : {}),
      });
      if (!effectivePolicy.values.enabled) {
        throw new AuditPolicyDisabledError(input.eventType, input.eventVersion);
      }

      const snapshotWhere = and(
        eq(entitySnapshots.tenantId, input.tenantId),
        eq(entitySnapshots.entityType, input.subjectType),
        eq(entitySnapshots.entityId, input.subjectId),
      );
      await tx
        .insert(entitySnapshots)
        .values({
          tenantId: input.tenantId,
          entityType: input.subjectType,
          entityId: input.subjectId,
          snapshotStatus: 'current',
          snapshotData: null,
          lastSubjectSequence: 0,
        })
        .onConflictDoNothing({ target: [entitySnapshots.tenantId, entitySnapshots.entityType, entitySnapshots.entityId] });

      const snapshotRows = await tx
        .select({ lastSubjectSequence: entitySnapshots.lastSubjectSequence })
        .from(entitySnapshots)
        .where(snapshotWhere)
        .limit(1)
        .for('update');
      const snapshotRow = snapshotRows[0];
      if (!snapshotRow) throw new Error('Audit snapshot lock could not be established');

      const nextSubjectSequence = snapshotRow.lastSubjectSequence + 1;
      const mutation = await mutate(tx, nextSubjectSequence);
      const normalizedMutation = applySnapshotMode(
        normalizeAuditMutationForPersistence(
          { ...input, auditPolicy: buildPersistencePolicy(input.auditPolicy, effectivePolicy) },
          mutation,
          auditDefinition,
        ),
        effectivePolicy,
      );
      const metadata = sanitizeAuditMetadata(
        applyCanonicalModuleId(
          mergeAuditMetadata(
            mergeAuditMetadata(input.metadata, mutation.metadata),
            buildAuditPolicyMetadata(effectivePolicy),
          ),
          input.moduleId,
        ),
        effectivePolicy,
      );
      const telegramContext = sanitizeTelegramContext(input.telegramContext ?? buildTelegramContext(context));
      const [eventRow] = await tx
        .insert(events)
        .values({
          eventType: input.eventType,
          eventVersion: input.eventVersion,
          category: input.category,
          occurredAt: new Date(),
          source: input.source,
          status: input.status ?? 'recorded',
          tenantId: input.tenantId,
          actorId: input.actorId,
          actorType: input.actorType,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          subjectSequence: nextSubjectSequence,
          correlationId,
          telegramContext,
          idempotencyKey: input.idempotencyKey,
          before: normalizedMutation.before,
          after: normalizedMutation.after,
          beforeSnapshotStatus: normalizedMutation.beforeSnapshotStatus,
          afterSnapshotStatus: normalizedMutation.afterSnapshotStatus,
          changes: normalizedMutation.changes,
          metadata,
        })
        .returning({ id: events.id, subjectSequence: events.subjectSequence });

      if (!eventRow) throw new Error('Audit event insert returned no rows');

      await tx.insert(outbox).values({
        eventId: eventRow.id,
        destination: input.eventType,
        payload: {
          eventId: eventRow.id,
          eventType: input.eventType,
          eventVersion: input.eventVersion,
          category: input.category,
          status: input.status ?? 'recorded',
          tenantId: input.tenantId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          subjectSequence: eventRow.subjectSequence,
          before: normalizedMutation.before,
          after: normalizedMutation.after,
          beforeSnapshotStatus: normalizedMutation.beforeSnapshotStatus,
          afterSnapshotStatus: normalizedMutation.afterSnapshotStatus,
          changes: normalizedMutation.changes,
          metadata,
        },
      });

      await tx
        .update(entitySnapshots)
        .set({
          snapshotStatus: mutation.snapshotStatus ?? 'current',
          snapshotData: normalizedMutation.snapshotData,
          lastSubjectSequence: nextSubjectSequence,
          lastEventId: eventRow.id,
          updatedAt: new Date(),
        })
        .where(snapshotWhere);

      return { eventId: eventRow.id, subjectSequence: eventRow.subjectSequence, duplicate: false };
    });
  }
}

function auditRejectionStatus(error: unknown): AuditRejectionStatus {
  if (error instanceof AuditPolicyDisabledError) return 'policy_disabled';
  if (error instanceof AuditIdempotencyConflictError) return 'idempotency_conflict';
  if (
    error instanceof AuditSnapshotValidationError ||
    error instanceof UnregisteredAuditEventError ||
    error instanceof UnsupportedAuditEventVersionError ||
    error instanceof ForbiddenAuditValueError
  ) {
    return 'validation_failed';
  }
  return 'write_failed';
}

function sameIdempotentOperation(
  existing: {
    readonly tenantId: string;
    readonly eventType: string;
    readonly eventVersion: string;
    readonly category: string;
    readonly source: string;
    readonly status: AuditEventStatus;
    readonly actorId: string | null;
    readonly actorType: string | null;
    readonly subjectType: string;
    readonly subjectId: string;
  },
  input: AuditEventInput,
): boolean {
  return (
    existing.tenantId === input.tenantId &&
    existing.eventType === input.eventType &&
    existing.eventVersion === input.eventVersion &&
    existing.category === input.category &&
    existing.source === input.source &&
    existing.status === (input.status ?? 'recorded') &&
    existing.actorId === (input.actorId ?? null) &&
    existing.actorType === (input.actorType ?? null) &&
    existing.subjectType === input.subjectType &&
    existing.subjectId === input.subjectId
  );
}

function policyCategory(eventType: string, eventVersion: string): string {
  const match = /^v(\d+)$/.exec(eventVersion);
  if (!match) throw new Error(`Audit event version must use v<number> format, received "${eventVersion}"`);
  return auditEventRegistry.requireSupportedVersion(eventType, Number(match[1])).category;
}

function buildPersistencePolicy(
  inputPolicy: AuditPolicyContext | undefined,
  effectivePolicy: EffectiveAuditPolicy,
): AuditPolicyContext {
  return {
    allowMessageTextLogging: inputPolicy?.allowMessageTextLogging === true || effectivePolicy.values.allowlist.includes('text'),
    ...(effectivePolicy.sources.allowlist.source === 'policy' ? { allowlist: effectivePolicy.values.allowlist } : {}),
    ...(effectivePolicy.values.masking.length > 0 ? { masking: effectivePolicy.values.masking } : {}),
  };
}

function applySnapshotMode(
  mutation: NormalizedAuditPersistenceMutation,
  effectivePolicy: EffectiveAuditPolicy,
): NormalizedAuditPersistenceMutation {
  if (effectivePolicy.values.snapshotMode === 'snapshot') return mutation;
  return {
    before: undefined,
    after: undefined,
    beforeSnapshotStatus: redactObservedStatus(mutation.beforeSnapshotStatus),
    afterSnapshotStatus: redactObservedStatus(mutation.afterSnapshotStatus),
    snapshotData: null,
  };
}

function redactObservedStatus(status: SnapshotStatus): SnapshotStatus {
  return status === 'observed' ? 'redacted' : status;
}

function buildAuditPolicyMetadata(effectivePolicy: EffectiveAuditPolicy): Record<string, unknown> {
  return {
    auditPolicy: {
      values: effectivePolicy.values,
      sources: Object.fromEntries(
        Object.entries(effectivePolicy.sources).map(([key, source]) => [
          key,
          source.source === 'policy'
            ? { source: source.source, policyId: source.policyId, priority: source.priority }
            : { source: source.source },
        ]),
      ),
    },
  };
}

function buildTelegramContext(context: ReturnType<typeof getUpdateContext>): Record<string, unknown> | undefined {
  if (!context) return undefined;
  return {
    correlationId: context.correlationId,
    updateId: context.updateId,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.messageThreadId ? { messageThreadId: context.messageThreadId } : {}),
  };
}

function mergeAuditMetadata(
  inputMetadata: Record<string, unknown> | undefined,
  mutationMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (inputMetadata === undefined) return mutationMetadata;
  if (mutationMetadata === undefined) return inputMetadata;
  return { ...inputMetadata, ...mutationMetadata };
}

function applyCanonicalModuleId(
  metadata: Record<string, unknown> | undefined,
  moduleId: string | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return moduleId === undefined ? undefined : { moduleId };
  const result = { ...metadata };
  if (moduleId === undefined) {
    Reflect.deleteProperty(result, 'moduleId');
  } else {
    result.moduleId = moduleId;
  }
  return result;
}

function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
  effectivePolicy: EffectiveAuditPolicy,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const sanitized = applyAllowlist(metadata, AUDIT_OPERATIONAL_METADATA_ALLOWLIST, {
    allowMessageTextLogging: false,
    ...(effectivePolicy.values.masking.length === 0 ? {} : { masking: effectivePolicy.values.masking }),
  });
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

const AUDIT_TELEGRAM_CONTEXT_ALLOWLIST = [
  'correlationId',
  'updateId',
  'chatId',
  'userId',
  'messageThreadId',
] as const;

function sanitizeTelegramContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (context === undefined) return undefined;
  const projected = applyAllowlist(context, AUDIT_TELEGRAM_CONTEXT_ALLOWLIST);
  const safeEntries = Object.entries(projected).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].length > 0 && entry[1] !== '[redacted]',
  );
  return safeEntries.length === 0 ? undefined : Object.fromEntries(safeEntries);
}

function assertSafeAuditEnvelope(input: AuditEventInput, correlationId: string | undefined): void {
  const values = {
    tenantId: input.tenantId,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    category: input.category,
    source: input.source,
    actorId: input.actorId,
    actorType: input.actorType,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    correlationId,
    idempotencyKey: input.idempotencyKey,
    moduleId: input.moduleId,
  };
  for (const [field, value] of Object.entries(values)) {
    if (value !== undefined && isForbiddenAuditString(value)) throw new ForbiddenAuditValueError(field);
  }
}

import { and, eq } from 'drizzle-orm';

import { getUpdateContext } from './context.js';
import type { SnapshotStatus } from './audit/enums.js';
import type { AuditPolicyContext } from './audit/masking.js';
import { resolveEffectiveAuditPolicy, type EffectiveAuditPolicy } from './audit/policyResolution.js';
import {
  normalizeAuditMutationForPersistence,
  requireAuditPersistenceDefinition,
  type NormalizedAuditPersistenceMutation,
} from './audit/persistenceValidation.js';
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
  readonly snapshotData: TSnapshot;
}

export type AuditMutationResult<TSnapshot extends Record<string, unknown>> = AuditChange<TSnapshot>;

type AuditTransaction = Pick<DrizzleDatabase, 'select' | 'insert' | 'update' | 'delete'>;

export class AuditService {
  public constructor(private readonly db: DrizzleDatabase) {}

  public async recordEntityChange<TSnapshot extends Record<string, unknown>>(
    input: AuditEventInput,
    mutate: (tx: AuditTransaction, nextSubjectSequence: number) => Promise<AuditMutationResult<TSnapshot>>,
  ): Promise<{ readonly eventId: string; readonly subjectSequence: number; readonly duplicate: boolean }> {
    const context = getUpdateContext();
    const auditDefinition = requireAuditPersistenceDefinition(input);
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: events.id, subjectSequence: events.subjectSequence })
        .from(events)
        .where(eq(events.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing[0]) {
        return { eventId: existing[0].id, subjectSequence: existing[0].subjectSequence, duplicate: true };
      }

      const effectivePolicy = await resolveEffectiveAuditPolicy(tx, {
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        chatId: input.tenantId,
        ...(input.moduleId !== undefined ? { moduleId: input.moduleId } : {}),
      });
      if (!effectivePolicy.values.enabled) {
        throw new Error(`Audit policy is unavailable for ${input.eventType}@${input.eventVersion}`);
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
          snapshotData: {},
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
      const metadata = mergeAuditMetadata(
        mergeAuditMetadata(input.metadata, mutation.metadata),
        buildAuditPolicyMetadata(effectivePolicy),
      );
      const telegramContext = input.telegramContext ?? buildTelegramContext(context);
      const [eventRow] = await tx
        .insert(events)
        .values({
          eventType: input.eventType,
          eventVersion: input.eventVersion,
          category: input.category,
          occurredAt: new Date(),
          source: input.source,
          tenantId: input.tenantId,
          actorId: input.actorId,
          actorType: input.actorType,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          subjectSequence: nextSubjectSequence,
          correlationId: input.correlationId ?? context?.correlationId,
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
    ...(mutation.changes === undefined ? {} : { changes: mutation.changes }),
    snapshotData: {},
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

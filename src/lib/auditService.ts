import { and, eq } from 'drizzle-orm';

import { getUpdateContext } from './context.js';
import type { DrizzleDatabase } from '../db/client.js';
import { entitySnapshots, events } from '../db/schema/audit.js';

export interface AuditIdentity {
  readonly tenantId: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

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
}

export interface AuditChange<TSnapshot extends Record<string, unknown>> {
  readonly before: Record<string, unknown> | undefined;
  readonly after: Record<string, unknown>;
  readonly changes?: Record<string, unknown>;
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
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: events.id, subjectSequence: events.subjectSequence })
        .from(events)
        .where(eq(events.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing[0]) {
        return { eventId: existing[0].id, subjectSequence: existing[0].subjectSequence, duplicate: true };
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
          before: mutation.before,
          after: mutation.after,
          changes: mutation.changes,
          metadata: input.metadata,
        })
        .returning({ id: events.id, subjectSequence: events.subjectSequence });

      if (!eventRow) throw new Error('Audit event insert returned no rows');

      await tx
        .update(entitySnapshots)
        .set({
          snapshotStatus: 'current',
          snapshotData: mutation.snapshotData,
          lastSubjectSequence: nextSubjectSequence,
          lastEventId: eventRow.id,
          updatedAt: new Date(),
        })
        .where(snapshotWhere);

      return { eventId: eventRow.id, subjectSequence: eventRow.subjectSequence, duplicate: false };
    });
  }
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
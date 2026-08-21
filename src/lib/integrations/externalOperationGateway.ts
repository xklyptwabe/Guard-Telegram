import { recordIntegrationAction } from '../audit/integrationAudit.js';
import type { AuditService } from '../auditService.js';
import type { Logger } from '../logger.js';
import type { ModerationService } from '../moderation/moderationService.js';
import type { AttemptOutcome, PendingOperationFinalizer, PendingOperationRow } from '../moderation/pendingOperationsOutbox.js';

/**
 * ============================================================================
 * BOTS-9 review finding (BLOCKER-3): write-ahead for external integrations
 * ============================================================================
 * S3 `PutObject` and RabbitMQ publish used to execute the external call
 * first and record an `integration.action` audit event afterwards, with a
 * fresh random UUID as the idempotency key. A crash between the side effect
 * and the audit row left an undetectable external change: no durable
 * intent, no retry, no recovery, no way to reconstruct the missing record.
 *
 * Both now go through the same `PendingOperationsOutbox` the moderation
 * actions use (`s3.putObject` / `rabbitmq.publish` kinds on
 * `moderation.pending_operations`): intent is durably written BEFORE the
 * call, the outcome resolves to succeeded/failed/unknown with retry and
 * lease-based recovery, and the terminal `integration.action` event is
 * written by the finalizer below — with the operation's STABLE
 * `${idempotencyKey}:audit` key, so a retry or post-restart backfill can
 * never produce a second audit row for the same operation.
 *
 * Provider-specific notes live where the executors are registered
 * (`lib/storage.ts`: the body is never stored, recovery reconciles via
 * HEAD; `lib/rabbitmq.ts`: the envelope id is created before write-ahead so
 * every retry republishes the SAME id, making consumer-side dedup possible).
 */

/** Extracts the metadata `enqueue*` callers must write ahead for the audit finalizer to reconstruct the record after a restart. */
export interface IntegrationOperationMetadata {
  readonly integrationId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly chatId?: string;
}

export function integrationOperationMetadata(metadata: IntegrationOperationMetadata): Record<string, unknown> {
  return { ...metadata };
}

/**
 * Terminal `integration.action` audit for any `s3.*`/`rabbitmq.*` outbox
 * row. Everything needed comes from what was written ahead in
 * `row.metadata` (see {@link IntegrationOperationMetadata}) plus the
 * resolved outcome — a row recovered after a restart has no live call site
 * to ask.
 */
export function makeIntegrationAuditFinalizer(audit: AuditService, logger: Logger): PendingOperationFinalizer {
  return async (row: PendingOperationRow, outcome: AttemptOutcome) => {
    const integrationId = typeof row.metadata.integrationId === 'string' ? row.metadata.integrationId : undefined;
    const action = typeof row.metadata.action === 'string' ? row.metadata.action : undefined;
    const targetType = typeof row.metadata.targetType === 'string' ? row.metadata.targetType : undefined;
    const targetId = typeof row.metadata.targetId === 'string' ? row.metadata.targetId : undefined;
    if (!integrationId || !action || !targetType || !targetId) {
      // BLOCKER-1: missing metadata must never finalize as 'written'.
      logger.error({ event: 'audit.integration_action.recovered_without_metadata', details: { kind: row.kind, id: row.id } });
      throw new Error(`pending_operations row ${row.id} (${row.kind}) reached terminal state without the integration metadata needed to finalize its audit record`);
    }
    const statusCode = typeof outcome.result?.statusCode === 'number' ? outcome.result.statusCode : undefined;
    const chatId = typeof row.metadata.chatId === 'string' ? row.metadata.chatId : row.chatId === 'platform' ? undefined : row.chatId;
    return recordIntegrationAction(audit, logger, {
      integrationId,
      action,
      targetType,
      targetId,
      // Round-2 (HIGH-2): the operation's first-class outcome — failed and
      // unknown stay distinguishable in the audit record.
      outcome: outcome.status,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(chatId !== undefined ? { chatId } : {}),
      idempotencyKey: `${row.idempotencyKey}:audit`,
    });
  };
}

/**
 * One finalizer for the whole outbox, routing on the kind namespace:
 * `telegram.*` rows complete their audit via ModerationService (which
 * dispatches moderation.action vs message.deleted on its own), everything
 * else via the integration finalizer. Installed once at bootstrap for both
 * the boot sweep and the persistent worker.
 */
export function buildOutboxFinalizer(moderation: ModerationService, integration: PendingOperationFinalizer): PendingOperationFinalizer {
  return async (row, outcome) => {
    if (row.kind.startsWith('telegram.')) {
      return moderation.auditRecoveredOperation(row, outcome);
    }
    return integration(row, outcome);
  };
}

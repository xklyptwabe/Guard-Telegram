import { randomUUID } from 'node:crypto';

import { AuditEventProcessor } from './eventProcessor.js';
import { toDownstreamInput, toDownstreamMutationResult } from './serviceAdapter.js';
import { notApplicable, observed } from './snapshot.js';
import type { AuditService } from '../auditService.js';
import type { Logger } from '../logger.js';

const auditProcessor = new AuditEventProcessor();

export interface IntegrationActionInput {
  readonly integrationId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly statusCode?: number;
  readonly success: boolean;
}

/**
 * Records an `integration.action` audit event for one outbound call to an
 * external system (currently: RabbitMQ publish, S3 put — see
 * `lib/rabbitmq.ts` / `lib/storage.ts`).
 *
 * `idempotencyKey` is a fresh UUID per call, not content- or update-based.
 * Unlike `command.executed` (keyed on the Telegram update, to survive a
 * redelivered Update) or `module.state.changed` (keyed on target value),
 * there is no "redelivery" concept for an outbound integration call *we*
 * initiate — nothing upstream retries this specific call at the audit
 * layer, so there is nothing to dedupe against. A content-based key would
 * be actively wrong here: two genuinely separate, intentional calls with
 * identical fields (e.g. publishing the same action type twice on purpose)
 * would be wrongly collapsed into one record.
 *
 * Never throws — auditing an integration call must not affect whether that
 * call's own result reaches its caller. Any failure here (policy disabled,
 * transient DB issue) is logged and swallowed.
 */
export async function recordIntegrationAction(audit: AuditService, logger: Logger, input: IntegrationActionInput): Promise<void> {
  try {
    const idempotencyKey = `integration.action:${input.integrationId}:${input.action}:${randomUUID()}`;
    const record = auditProcessor.process({
      name: 'integration.action',
      version: 1,
      operation: 'create',
      idempotencyKey,
      before: notApplicable(),
      after: observed({
        integrationId: input.integrationId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
        success: input.success,
      }),
    });
    const downstreamInput = toDownstreamInput(record);
    const mutationResult = toDownstreamMutationResult(record);
    await audit.recordEntityChange(downstreamInput, () => Promise.resolve(mutationResult));
  } catch (error: unknown) {
    logger.warn({
      event: 'audit.integration_action.failed',
      details: { integrationId: input.integrationId, action: input.action, targetType: input.targetType, targetId: input.targetId },
      error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
    });
  }
}

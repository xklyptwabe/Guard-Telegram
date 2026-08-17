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
  /**
   * BOTS-9 review finding (HIGH-7): optional, forward-compatible. No
   * current caller (`storage.put`, `rabbitmq` publish) has chat context to
   * give, so omitting it is the common case and behaves exactly as before
   * (platform-wide policy applies). A future chat-scoped integration call
   * can pass it to get that chat's own audit policy instead.
   */
  readonly chatId?: string;
  /**
   * BOTS-9 review finding (BLOCKER-3): when the audit is the terminal
   * record of a write-ahead outbox operation, the key is the operation's
   * stable `${idempotencyKey}:audit` — NOT a fresh UUID — so a retry or
   * post-restart backfill of the same operation collapses to exactly one
   * audit event. Omit for standalone (non-outbox) integration calls, where
   * a per-call UUID remains correct (see the class doc).
   */
  readonly idempotencyKey?: string;
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
    const idempotencyKey = input.idempotencyKey ?? `integration.action:${input.integrationId}:${input.action}:${randomUUID()}`;
    const record = auditProcessor.process({
      name: 'integration.action',
      version: 1,
      operation: 'create',
      idempotencyKey,
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
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

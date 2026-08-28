import { AuditEventProcessor } from './eventProcessor.js';
import { toDownstreamInput, toDownstreamMutationResult } from './serviceAdapter.js';
import { notApplicable, observed } from './snapshot.js';
import { AuditPolicyDisabledError, type AuditService } from '../auditService.js';
import type { Logger } from '../logger.js';
import type {
  PendingOperationFinalizer,
  PendingOperationRecoveryMetadata,
  PendingOperationResolvers,
} from '../moderation/pendingOperationsOutbox.js';

export const commandAuditOperationKind = 'command.audit';

export interface CommandExecutedAuditInput {
  readonly chatId: string;
  readonly userId: string;
  readonly moduleId: string;
  readonly commandName: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly idempotencyKey: string;
}

const auditProcessor = new AuditEventProcessor();

export function commandAuditRecoveryMetadata(input: CommandExecutedAuditInput): PendingOperationRecoveryMetadata & Record<string, unknown> {
  return {
    action: input.commandName,
    actorUserId: input.userId,
    moduleId: input.moduleId,
    durationMs: input.durationMs,
    success: input.success,
  };
}

export async function recordCommandExecuted(
  audit: AuditService,
  logger: Logger,
  input: CommandExecutedAuditInput,
): Promise<{ readonly status: 'recorded' } | { readonly status: 'policy_skipped' }> {
  try {
    const record = auditProcessor.process({
      name: 'command.executed',
      version: 1,
      operation: 'create',
      chatId: input.chatId,
      actorId: input.userId,
      idempotencyKey: input.idempotencyKey,
      before: notApplicable(),
      after: observed({
        chatId: input.chatId,
        userId: input.userId,
        moduleId: input.moduleId,
        commandId: input.commandName,
        argsRedacted: true,
        durationMs: input.durationMs,
        success: input.success,
      }),
    });
    const downstreamInput = { ...toDownstreamInput(record), moduleId: input.moduleId };
    await audit.recordEntityChange(downstreamInput, () => Promise.resolve(toDownstreamMutationResult(record)));
    return { status: 'recorded' };
  } catch (error: unknown) {
    if (error instanceof AuditPolicyDisabledError) {
      logger.info({ event: 'audit.command_executed.policy_skipped', module: input.moduleId, chatId: input.chatId, userId: input.userId, commandName: input.commandName });
      return { status: 'policy_skipped' };
    }
    logger.warn({
      event: 'audit.command_executed.failed',
      module: input.moduleId,
      chatId: input.chatId,
      userId: input.userId,
      commandName: input.commandName,
      error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

export function makeCommandAuditFinalizer(audit: AuditService, logger: Logger): PendingOperationFinalizer {
  return async (row) => {
    const commandName = typeof row.recoveryMetadata.action === 'string' ? row.recoveryMetadata.action : undefined;
    const userId = typeof row.recoveryMetadata.actorUserId === 'string' ? row.recoveryMetadata.actorUserId : undefined;
    const moduleId = typeof row.recoveryMetadata.moduleId === 'string' ? row.recoveryMetadata.moduleId : undefined;
    const durationMs = typeof row.recoveryMetadata.durationMs === 'number' ? row.recoveryMetadata.durationMs : undefined;
    const success = typeof row.recoveryMetadata.success === 'boolean' ? row.recoveryMetadata.success : undefined;
    if (!commandName || !userId || !moduleId || durationMs === undefined || success === undefined) {
      logger.error({ event: 'audit.command_executed.recovered_without_metadata', details: { kind: row.kind, id: row.id } });
      throw new Error(`pending_operations row ${row.id} (${row.kind}) lacks command audit recovery metadata`);
    }
    return recordCommandExecuted(audit, logger, {
      chatId: row.chatId,
      userId,
      moduleId,
      commandName,
      durationMs,
      success,
      idempotencyKey: row.idempotencyKey,
    });
  };
}

export function registerCommandAuditResolver(resolvers: PendingOperationResolvers): void {
  resolvers.register(commandAuditOperationKind, () => Promise.resolve({}));
}

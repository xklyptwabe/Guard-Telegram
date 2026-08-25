import { createHash, randomUUID } from 'node:crypto';

import type { Context } from 'grammy';

import type { AppConfig } from '../config.js';
import { getUpdateContext } from './context.js';
import { integrationOperationMetadata } from './integrations/externalOperationGateway.js';
import type { Logger } from './logger.js';
import { AuditFinalizationPendingError, type PendingOperationResolvers, type PendingOperationsOutbox } from './moderation/pendingOperationsOutbox.js';

export interface ReplyOptions {
  readonly allowTopicFallback?: boolean;
}

function getMessageThreadId(ctx: Context): number | undefined {
  if ('message' in ctx.update && ctx.update.message?.message_thread_id !== undefined) return ctx.update.message.message_thread_id;
  if ('callback_query' in ctx.update && ctx.update.callback_query.message?.message_thread_id !== undefined) return ctx.update.callback_query.message.message_thread_id;
  return undefined;
}

function isTopicError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /TOPIC_CLOSED|message thread not found/i.test(error.message);
}

export class ReplyService {
  private readonly kind = 'integration.telegram.sendMessage';

  public constructor(
    private readonly config: Pick<AppConfig, 'telegramTopicFallbackToChat'>,
    private readonly logger: Logger,
    private readonly outbox?: PendingOperationsOutbox,
    resolvers?: PendingOperationResolvers,
  ) {
    resolvers?.register(
      this.kind,
      () => Promise.reject(new Error('sendMessage content is intentionally not persisted; interrupted delivery remains unknown')),
      { retryAfterUnknown: false },
    );
  }

  public async send(ctx: Context, text: string, options: ReplyOptions = {}): Promise<void> {
    if (!ctx.chat) return;
    const messageThreadId = getMessageThreadId(ctx);
    try {
      await this.sendWithAudit(ctx, text, messageThreadId, 'primary');
    } catch (error: unknown) {
      if (!messageThreadId || !isTopicError(error) || !options.allowTopicFallback || !this.config.telegramTopicFallbackToChat) {
        if (isTopicError(error)) this.logger.warn({ event: 'reply.topic.unavailable', chatId: String(ctx.chat.id) });
        throw error;
      }
      this.logger.warn({ event: 'reply.topic.fallback_to_chat', chatId: String(ctx.chat.id) });
      await this.sendWithAudit(ctx, text, undefined, 'fallback');
    }
  }

  private async sendWithAudit(ctx: Context, text: string, messageThreadId: number | undefined, occurrence: 'primary' | 'fallback'): Promise<void> {
    if (!ctx.chat) return;
    if (!this.outbox) {
      if (messageThreadId === undefined) await ctx.api.sendMessage(ctx.chat.id, text);
      else await ctx.api.sendMessage(ctx.chat.id, text, { message_thread_id: messageThreadId });
      return;
    }
    const context = getUpdateContext();
    const textDigest = createHash('sha256').update(text).digest('hex');
    const operationId = context
      ? `${context.botId ?? 'unscoped-bot'}:${context.updateId}:${ctx.chat.id}:${messageThreadId ?? 'chat'}:${occurrence}:${textDigest}`
      : randomUUID();
    const metadata = integrationOperationMetadata({ integrationId: 'telegram', action: 'sendMessage', targetType: 'chat', targetId: String(ctx.chat.id), chatId: String(ctx.chat.id) });
    const result = await this.outbox.execute(
      {
        kind: this.kind,
        chatId: String(ctx.chat.id),
        idempotencyKey: `telegram.sendMessage:${operationId}`,
        requestPayload: { chat_id: ctx.chat.id, ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}), textDigest, sizeBytes: Buffer.byteLength(text) },
        auditEvent: { eventType: 'integration.action', eventVersion: 'v1' },
        metadata,
        recoveryMetadata: metadata,
      },
      async () => {
        const sent = messageThreadId === undefined
          ? await ctx.api.sendMessage(ctx.chat!.id, text)
          : await ctx.api.sendMessage(ctx.chat!.id, text, { message_thread_id: messageThreadId });
        return { messageId: sent.message_id };
      },
    );
    if (result.isFinal && !result.auditFinalized) throw new AuditFinalizationPendingError('Telegram sendMessage audit is still owed');
    if (result.outcome.status !== 'succeeded') {
      const description = typeof result.outcome.result?.description === 'string' ? result.outcome.result.description : '';
      throw new Error(`Telegram sendMessage ${result.outcome.status}${description ? `: ${description}` : ''}`);
    }
  }
}

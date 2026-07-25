import type { Context } from 'grammy';

import type { AppConfig } from '../config.js';
import type { Logger } from './logger.js';

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
  public constructor(private readonly config: Pick<AppConfig, 'telegramTopicFallbackToChat'>, private readonly logger: Logger) {}

  public async send(ctx: Context, text: string, options: ReplyOptions = {}): Promise<void> {
    if (!ctx.chat) return;
    const messageThreadId = getMessageThreadId(ctx);
    try {
      await ctx.api.sendMessage(ctx.chat.id, text, messageThreadId === undefined ? {} : { message_thread_id: messageThreadId });
    } catch (error: unknown) {
      if (!messageThreadId || !isTopicError(error) || !options.allowTopicFallback || !this.config.telegramTopicFallbackToChat) {
        if (isTopicError(error)) this.logger.warn({ event: 'reply.topic.unavailable', chatId: String(ctx.chat.id) });
        throw error;
      }
      this.logger.warn({ event: 'reply.topic.fallback_to_chat', chatId: String(ctx.chat.id) });
      await ctx.api.sendMessage(ctx.chat.id, text);
    }
  }
}

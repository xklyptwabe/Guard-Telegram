import type { Context } from 'grammy';

import type { AppConfig } from '../config.js';
import { bots9WalExclusion } from './bots9WalExclusions.js';
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

/**
 * BOTS-9 review finding (HIGH-5) — documented exclusion: `sendMessage` is
 * deliberately NOT routed through the write-ahead outbox. It is
 * user-facing UX feedback whose value decays in seconds; a post-restart
 * retry would deliver stale replies hours later, which is worse than the
 * rare lost reply. The command's own outcome (and its `command.executed`
 * audit) is recorded independently of whether its reply was delivered.
 */
export class ReplyService {
  public constructor(private readonly config: Pick<AppConfig, 'telegramTopicFallbackToChat'>, private readonly logger: Logger) {}

  public async send(ctx: Context, text: string, options: ReplyOptions = {}): Promise<void> {
    if (!ctx.chat) return;
    const messageThreadId = getMessageThreadId(ctx);
    try {
      void bots9WalExclusion('telegram.sendMessage');
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

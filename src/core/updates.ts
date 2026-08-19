import { createServer, type IncomingMessage, type Server } from 'node:http';

import { run, type RunnerHandle } from '@grammyjs/runner';
import { type Bot, type Context } from 'grammy';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import type { DrizzleDatabase } from '../db/client.js';
import { telegramUsers } from '../db/schema/core.js';
import type { AuditService } from '../lib/auditService.js';
import { recordBotMembershipChanged } from '../lib/audit/botMembershipAudit.js';
import { runWithUpdateContext } from '../lib/context.js';
import type { Logger } from '../lib/logger.js';
import type { ModuleRegistry } from './registry.js';
import type { TelegramBotModule } from './contracts.js';
import { AuditFinalizationPendingError } from '../lib/moderation/pendingOperationsOutbox.js';
import { UpdateInbox } from './updateInbox.js';

const webhookUpdateSchema = z.object({ update_id: z.number().int() }).passthrough();

export interface TransportController {
  stop(): Promise<void>;
}

/**
 * BOTS-9 review round-2 (BLOCKER-4): thrown by the platform middleware when
 * a webhook-delivered update is busy (live lease held elsewhere, or still
 * inside its backoff window) — the transport MUST NOT answer 200 for work
 * that is still owed; Telegram redelivers on a non-2xx. Attempts-exhausted
 * rows answer 200 (permanently undeliverable — retrying forever would just
 * loop).
 */
export class UpdateBusyError extends Error {
  public constructor(updateId: string, reason: string) {
    super(`Update ${updateId} is busy (${reason})`);
    this.name = 'UpdateBusyError';
  }
}

function chatTitle(ctx: Context): string | undefined {
  return ctx.chat && 'title' in ctx.chat ? ctx.chat.title : undefined;
}

function messageThreadId(ctx: Context): string | undefined {
  if ('message' in ctx.update && ctx.update.message?.message_thread_id !== undefined) {
    return String(ctx.update.message.message_thread_id);
  }
  if ('callback_query' in ctx.update && ctx.update.callback_query.message?.message_thread_id !== undefined) {
    return String(ctx.update.callback_query.message.message_thread_id);
  }
  return undefined;
}

export function registerPlatformMiddleware(bot: Bot<Context>, database: DrizzleDatabase, registry: ModuleRegistry, logger: Logger, transportMode: 'long_polling' | 'webhook' = 'long_polling'): void {
  // BOTS-9 review fix (BLOCKER-5): the old code inserted the
  // processed_updates marker BEFORE `await next()` — any crash or handler
  // exception after that insert permanently lost the update, because
  // redelivery found the marker and skipped. UpdateInbox turns the marker
  // into a durable received→processing→completed state machine: only a
  // `completed` row dedups; anything else is reprocessed on redelivery.
  // The raw update is never stored (BLOCKER-4) — Telegram's own
  // redelivery drives the retry.
  const inbox = new UpdateInbox(database, logger);
  bot.use(async (ctx, next) => {
    const updateId = String(ctx.update.update_id);
    const botId = ctx.me ? String(ctx.me.id) : undefined;
    const chatId = ctx.chat ? String(ctx.chat.id) : undefined;
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    const threadId = messageThreadId(ctx);
    await runWithUpdateContext(
      { updateId, ...(botId ? { botId } : {}), ...(chatId ? { chatId } : {}), ...(userId ? { userId } : {}), ...(threadId ? { messageThreadId: threadId } : {}) },
      async () => {
        if (ctx.chat) await registry.ensureChat(chatId!, ctx.chat.type, chatTitle(ctx));
        if (ctx.from) {
          const now = new Date();
          await database
            .insert(telegramUsers)
            .values({ userId: String(ctx.from.id), ...(ctx.from.language_code ? { languageCode: ctx.from.language_code } : {}), updatedAt: now })
            .onConflictDoUpdate({
              target: telegramUsers.userId,
              set: { ...(ctx.from.language_code ? { languageCode: ctx.from.language_code } : {}), updatedAt: now },
            });
        }
        const { claim, attemptCount, busyReason } = await inbox.begin(String(ctx.me.id), updateId);
        if (claim === 'completed') {
          logger.info({ event: 'update.duplicate_skipped' });
          return;
        }
        if (claim === 'busy') {
          // Live lease elsewhere, inside the backoff window, or attempts
          // exhausted. Transient busy must NEVER look like success: webhook
          // answers 409; long polling throws so grammy does not advance
          // getUpdates offset (round-3: default transport is long_polling).
          if (busyReason !== 'exhausted') {
            throw new UpdateBusyError(updateId, busyReason ?? 'unknown');
          }
          logger.info({ event: 'update.inbox.busy_skipped', details: { updateId, attemptCount, busyReason, transportMode } });
          return;
        }
        logger.debug({ event: 'update.received' });
        try {
          await next();
          await inbox.complete(String(ctx.me.id), updateId);
        } catch (error: unknown) {
          await inbox.fail(String(ctx.me.id), updateId, attemptCount, error);
          throw error;
        }
      },
    );
  });
}

export function registerModuleUpdateHandlers(bot: Bot<Context>, modules: readonly TelegramBotModule[], registry: ModuleRegistry, logger: Logger): void {
  bot.use(async (ctx, next) => {
    if (ctx.chat) {
      const chatId = String(ctx.chat.id);
      for (const module of modules) {
        if (!(await registry.isEnabled(chatId, module.id))) continue;
        for (const handler of module.updateHandlers ?? []) {
          try {
            await handler.handle(ctx);
          } catch (error: unknown) {
            if (error instanceof AuditFinalizationPendingError || (error instanceof Error && error.name === 'AuditFinalizationPendingError')) throw error;
            logger.error({ event: 'module.update_handler.failed', module: module.id, details: { handlerId: handler.id }, error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
          }
        }
      }
    }
    await next();
  });
}

/**
 * BOTS-9: registers `bot.membership.changed` auditing directly on the bot
 * — deliberately not routed through `registerModuleUpdateHandlers` (and
 * therefore never gated by any module's enabled/disabled state). The
 * event's definition marks it `canBeDisabled: false`: whether the bot
 * itself can still act in a chat is core infrastructure, not an optional
 * feature a chat's admins should be able to silence.
 */
export function registerBotMembershipAudit(bot: Bot<Context>, audit: AuditService, logger: Logger): void {
  bot.use(async (ctx, next) => {
    await recordBotMembershipChanged(audit, logger, ctx);
    await next();
  });
}

export function startLongPolling(bot: Bot<Context>, config: Pick<AppConfig, 'telegramAllowedUpdates' | 'telegramRunnerConcurrency'>, logger: Logger): TransportController {
  const runner: RunnerHandle = run(bot, {
    runner: { fetch: { allowed_updates: config.telegramAllowedUpdates } },
    sink: { concurrency: config.telegramRunnerConcurrency },
  });
  logger.info({ event: 'transport.long_polling.started' });
  return {
    async stop(): Promise<void> {
      await runner.stop();
      logger.info({ event: 'transport.long_polling.stopped' });
    },
  };
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) reject(new Error('Webhook payload exceeds size limit'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/**
 * BOTS-9 review finding (HIGH-5) — documented exclusion: `setWebhook` is
 * deliberately NOT routed through the write-ahead outbox. Same reasoning
 * as `setMyCommands`: bootstrap-only, idempotent (same URL/secret/allowed
 * updates → same state), and retried by the next restart. The webhook
 * secret never leaves this process for the outbox (BLOCKER-4) — storing it
 * in a write-ahead row would be a new leak, not a reliability gain.
 */
export async function startWebhook(bot: Bot<Context>, config: AppConfig, logger: Logger): Promise<TransportController> {
  if (!config.telegramWebhookUrl || !config.telegramWebhookSecret) throw new Error('Webhook configuration is incomplete');
  const webhookUrl = new URL(config.telegramWebhookUrl);
  const secret = config.telegramWebhookSecret;
  await bot.api.setWebhook(webhookUrl.toString(), {
    secret_token: secret,
    allowed_updates: config.telegramAllowedUpdates,
  });
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const requestUrl = new URL(request.url ?? '/', webhookUrl);
        const providedSecret = request.headers['x-telegram-bot-api-secret-token'];
        if (request.method !== 'POST' || requestUrl.pathname !== webhookUrl.pathname || providedSecret !== secret) {
          response.writeHead(401).end();
          return;
        }
        const body = webhookUpdateSchema.parse(JSON.parse(await readBody(request, 1024 * 1024)));
        await bot.handleUpdate(body);
        response.writeHead(200).end();
      } catch (error: unknown) {
        // Round-2 (BLOCKER-4): busy ≠ 200 — a transiently busy update must
        // be redelivered by Telegram, not confirmed as processed.
        if (error instanceof UpdateBusyError || error instanceof AuditFinalizationPendingError) {
          // Transient: Telegram must redeliver. 503 (not 400) so operators
          // and future retry filters do not treat this as a malformed update.
          response.writeHead(error instanceof UpdateBusyError ? 409 : 503).end();
          return;
        }
        logger.error({ event: 'transport.webhook.request_failed', error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
        response.writeHead(400).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.telegramWebhookPort, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ event: 'transport.webhook.started', details: { port: config.telegramWebhookPort } });
  return {
    async stop(): Promise<void> {
      await closeServer(server);
      logger.info({ event: 'transport.webhook.stopped' });
    },
  };
}

import { createServer, type IncomingMessage, type Server } from 'node:http';

import { BotError, type Bot, type Context } from 'grammy';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import type { DrizzleDatabase } from '../db/client.js';
import { telegramUsers } from '../db/schema/core.js';
import type { AuditService } from '../lib/auditService.js';
import { recordBotMembershipChanged } from '../lib/audit/botMembershipAudit.js';
import { runWithUpdateContext } from '../lib/context.js';
import { constantTimeEquals } from '../lib/cryptoEquals.js';
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
 * a delivered update is busy (live lease held elsewhere, or still inside
 * its backoff window) — the transport MUST NOT confirm the update.
 */
export class UpdateBusyError extends Error {
  public constructor(updateId: string, reason: string) {
    super(`Update ${updateId} is busy (${reason})`);
    this.name = 'UpdateBusyError';
  }
}

/** grammY wraps every middleware throw in BotError — HTTP layer must unwrap. */
export function unwrapMiddlewareError(error: unknown): unknown {
  return error instanceof BotError ? error.error : error;
}

export function isTransientUpdateError(error: unknown): boolean {
  const cause = unwrapMiddlewareError(error);
  return (
    cause instanceof UpdateBusyError ||
    cause instanceof AuditFinalizationPendingError ||
    (cause instanceof Error && (cause.name === 'UpdateBusyError' || cause.name === 'AuditFinalizationPendingError'))
  );
}

/** HTTP status for a failed webhook handleUpdate. Never 200 for owed work. */
export function webhookStatusForError(error: unknown): 409 | 503 | 400 {
  const cause = unwrapMiddlewareError(error);
  if (cause instanceof UpdateBusyError || (cause instanceof Error && cause.name === 'UpdateBusyError')) return 409;
  if (cause instanceof AuditFinalizationPendingError || (cause instanceof Error && cause.name === 'AuditFinalizationPendingError')) return 503;
  return 400;
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

export function registerBotMembershipAudit(bot: Bot<Context>, audit: AuditService, logger: Logger): void {
  bot.use(async (ctx, next) => {
    await recordBotMembershipChanged(audit, logger, ctx);
    await next();
  });
}

/**
 * Sequential long polling that advances Telegram's offset ONLY after
 * handleUpdate succeeds. @grammyjs/runner increments offset at fetch time,
 * so a later throw could never be redelivered — this loop keeps the same
 * offset on transient failures (busy / audit-pending / crash).
 */
export function startLongPolling(bot: Bot<Context>, config: Pick<AppConfig, 'telegramAllowedUpdates' | 'telegramRunnerConcurrency'>, logger: Logger): TransportController {
  const abort = new AbortController();
  let offset = 0;
  const loop = (async () => {
    logger.info({ event: 'transport.long_polling.started', details: { concurrencyHint: config.telegramRunnerConcurrency } });
    while (!abort.signal.aborted) {
      try {
        const updates = await bot.api.getUpdates(
          { offset, timeout: 30, limit: 100, allowed_updates: config.telegramAllowedUpdates },
          abort.signal as never,
        );
        for (const update of updates) {
          if (abort.signal.aborted) return;
          try {
            await bot.handleUpdate(update);
            offset = update.update_id + 1;
          } catch (error: unknown) {
            logger.warn({
              event: isTransientUpdateError(error) ? 'transport.long_polling.will_retry' : 'transport.long_polling.update_failed',
              details: { updateId: update.update_id, offset },
              error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
            });
            await sleep(500, abort.signal);
            break;
          }
        }
      } catch (error: unknown) {
        if (abort.signal.aborted) return;
        logger.error({
          event: 'transport.long_polling.fetch_failed',
          error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) },
        });
        await sleep(2000, abort.signal);
      }
    }
  })();

  return {
    async stop(): Promise<void> {
      abort.abort();
      await loop.catch(() => undefined);
      logger.info({ event: 'transport.long_polling.stopped' });
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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

function webhookSecretMatches(provided: string | readonly string[] | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  return constantTimeEquals(provided, expected);
}

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
        if (request.method !== 'POST' || requestUrl.pathname !== webhookUrl.pathname || !webhookSecretMatches(providedSecret, secret)) {
          response.writeHead(401).end();
          return;
        }
        const body = webhookUpdateSchema.parse(JSON.parse(await readBody(request, 1024 * 1024)));
        await bot.handleUpdate(body);
        response.writeHead(200).end();
      } catch (error: unknown) {
        const status = webhookStatusForError(error);
        if (status !== 400) {
          response.writeHead(status).end();
          return;
        }
        logger.error({ event: 'transport.webhook.request_failed', error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
        response.writeHead(400).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.telegramWebhookPort, config.telegramWebhookHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ event: 'transport.webhook.started', details: { port: config.telegramWebhookPort, host: config.telegramWebhookHost } });
  return {
    async stop(): Promise<void> {
      await closeServer(server);
      logger.info({ event: 'transport.webhook.stopped' });
    },
  };
}

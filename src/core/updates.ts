import { createServer, type IncomingMessage, type Server } from 'node:http';

import { run, type RunnerHandle } from '@grammyjs/runner';
import { type Bot, type Context } from 'grammy';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import type { DrizzleDatabase } from '../db/client.js';
import { processedUpdates, telegramUsers } from '../db/schema/core.js';
import { runWithUpdateContext } from '../lib/context.js';
import type { Logger } from '../lib/logger.js';
import type { ModuleRegistry } from './registry.js';
import type { TelegramBotModule } from './contracts.js';

const webhookUpdateSchema = z.object({ update_id: z.number().int() }).passthrough();

export interface TransportController {
  stop(): Promise<void>;
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

export function registerPlatformMiddleware(bot: Bot<Context>, database: DrizzleDatabase, registry: ModuleRegistry, logger: Logger): void {
  bot.use(async (ctx, next) => {
    const updateId = String(ctx.update.update_id);
    const chatId = ctx.chat ? String(ctx.chat.id) : undefined;
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    const threadId = messageThreadId(ctx);
    await runWithUpdateContext(
      { updateId, ...(chatId ? { chatId } : {}), ...(userId ? { userId } : {}), ...(threadId ? { messageThreadId: threadId } : {}) },
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
        const inserted = await database
          .insert(processedUpdates)
          .values({ botId: String(ctx.me.id), updateId })
          .onConflictDoNothing({ target: [processedUpdates.botId, processedUpdates.updateId] })
          .returning({ updateId: processedUpdates.updateId });
        if (inserted.length === 0) {
          logger.info({ event: 'update.duplicate_skipped' });
          return;
        }
        logger.debug({ event: 'update.received' });
        await next();
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
            logger.error({ event: 'module.update_handler.failed', module: module.id, details: { handlerId: handler.id }, error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
          }
        }
      }
    }
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

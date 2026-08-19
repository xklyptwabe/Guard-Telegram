import 'dotenv/config';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { validateConfig } from './config.js';
import { collectCommands, registerCommands } from './core/commandRegistrar.js';
import { CommandDispatcher } from './core/dispatcher.js';
import { validateModules } from './core/loader.js';
import { ModuleRegistry } from './core/registry.js';
import { createTelegramBot } from './core/telegram.js';
import { registerBotMembershipAudit, registerModuleUpdateHandlers, registerPlatformMiddleware, startLongPolling, startWebhook, type TransportController } from './core/updates.js';
import { createDatabase } from './db/client.js';
import { purgeExpiredProcessedUpdates } from './db/retention.js';
import { createRedis } from './db/redis.js';
import { initializeI18n } from './i18n/index.js';
import { AuditService } from './lib/auditService.js';
import { startBackendApiServer, type BackendApiController } from './api/server.js';
import { ChatSettingsService } from './lib/chatSettings.js';
import { Cooldowns } from './lib/cooldowns.js';
import { EventBus } from './lib/eventBus.js';
import { healthSnapshot } from './lib/health.js';
import { Logger } from './lib/logger.js';
import { ModerationService } from './lib/moderation/moderationService.js';
import { PendingOperationResolvers, PendingOperationsOutbox } from './lib/moderation/pendingOperationsOutbox.js';
import { buildOutboxFinalizer, makeIntegrationAuditFinalizer } from './lib/integrations/externalOperationGateway.js';
import { createRabbitMq, registerPlatformRabbitActionSchemas } from './lib/rabbitmq.js';
import { ReplyService } from './lib/reply.js';
import { createStorage } from './lib/storage.js';
import { createModules } from './modules/index.js';

async function bootstrap(): Promise<void> {
  const config = validateConfig();
  const logger = new Logger(config);
  logger.info({ event: 'bootstrap.started' });
  const i18n = await initializeI18n();
  const database = createDatabase(config, logger);
  let transport: TransportController | undefined;
  let redis: Awaited<ReturnType<typeof createRedis>> | undefined;
  let storage: ReturnType<typeof createStorage> | undefined;
  let rabbitMq: Awaited<ReturnType<typeof createRabbitMq>> | undefined;
  let moderation: ModerationService | undefined;
  let sharedOutbox: PendingOperationsOutbox | undefined;
  let backendApi: BackendApiController | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'shutdown.started', details: { signal } });
    // BOTS-9 review fix (BLOCKER-2): stop the outbox's persistent poll
    // loop AND drain the sweep already in flight before closing the
    // database pool it depends on (round-2 MEDIUM: stopWorker alone could
    // return while a sweep was mid-finalize, stranding rows and re-running
    // the whole operation after restart).
    await sharedOutbox?.stopAndDrain();
    const closers = [transport?.stop(), backendApi?.stop(), rabbitMq?.close(), redis?.close(), storage?.close(), database.close()].filter(
      (operation): operation is Promise<void> => operation !== undefined,
    );
    const results = await Promise.allSettled(closers);
    for (const result of results) {
      if (result.status === 'rejected') logger.error({ event: 'shutdown.component_failed', error: { name: result.reason instanceof Error ? result.reason.name : 'UnknownError', message: result.reason instanceof Error ? result.reason.message : String(result.reason) } });
    }
    logger.info({ event: 'shutdown.completed' });
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await migrate(database.db, { migrationsFolder: 'src/db/migrations' });
    logger.info({ event: 'database.migrations.completed' });
    await purgeExpiredProcessedUpdates(database.db);
    redis = await createRedis(config, logger);
    const audit = new AuditService(database.db);
    const bot = createTelegramBot(config, logger);
    await bot.init();

    // BOTS-9 review fix (BLOCKER-3): one write-ahead outbox for ALL external
    // operations — Telegram moderation, S3 PutObject, RabbitMQ publish —
    // created before the integration clients so they can register their
    // kinds/executors on it.
    const pendingOperationResolvers = new PendingOperationResolvers();
    const pendingOperationsOutbox = new PendingOperationsOutbox(database.db, logger, pendingOperationResolvers);
    sharedOutbox = pendingOperationsOutbox;
    storage = createStorage(config, logger, pendingOperationsOutbox, pendingOperationResolvers);
    rabbitMq = await createRabbitMq(config, logger, audit, pendingOperationsOutbox, pendingOperationResolvers);
    registerPlatformRabbitActionSchemas(rabbitMq);
    const chatSettings = new ChatSettingsService(database.db, audit);
    moderation = new ModerationService(bot, audit, pendingOperationsOutbox, pendingOperationResolvers, logger);
    // One terminal-audit finalizer for every kind: telegram.* → moderation
    // events, everything else → integration.action (BLOCKER-3 + HIGH-3).
    const outboxFinalizer = buildOutboxFinalizer(moderation, makeIntegrationAuditFinalizer(audit, logger));

    const modules = createModules({ audit, logger, chatSettings, moderation });
    validateModules(modules);
    const events = new EventBus(logger);
    const registry = new ModuleRegistry(modules, database.db, audit, events, logger);
    const reply = new ReplyService(config, logger);
    const dispatcher = new CommandDispatcher(collectCommands(modules), registry, new Cooldowns(), reply, events, i18n, logger, audit);
    registerPlatformMiddleware(bot, database.db, registry, logger, config.telegramTransport);
    registerBotMembershipAudit(bot, audit, logger);
    registerModuleUpdateHandlers(bot, modules, registry, logger);
    await registerCommands(bot, modules, dispatcher, i18n, logger);

    // BOTS-9: resume anything the write-ahead outbox left unresolved before
    // this process last stopped — before accepting new traffic, so recovery
    // never races a fresh command for the same target. The same finalizer
    // also backfills any terminal operation whose audit write failed
    // (HIGH-3).
    await pendingOperationsOutbox.recoverPending(outboxFinalizer);
    // BOTS-9 review fix (BLOCKER-2): keep resuming/retrying for as long as
    // the process stays up, not only once at bootstrap.
    pendingOperationsOutbox.startWorker(outboxFinalizer);

    transport = config.telegramTransport === 'webhook' ? await startWebhook(bot, config, logger) : startLongPolling(bot, config, logger);
    if (config.backendApiEnabled) {
      backendApi = await startBackendApiServer(config, database.db, audit, logger);
    }
    logger.info({ event: 'bootstrap.completed', details: { ...healthSnapshot(config, redis, storage, rabbitMq) } });
  } catch (error: unknown) {
    logger.error({ event: 'bootstrap.failed', error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
    await shutdown('bootstrap_failed');
    process.exitCode = 1;
  }
}

void bootstrap();

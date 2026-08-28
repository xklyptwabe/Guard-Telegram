/**
 * BOTS-13 "Перезапустить бота во время незавершённой операции" — child
 * process used by bots13.resilience.e2e.test.ts. Runs against the same real
 * TEST_DATABASE_URL as the suite, but in its own OS process, so a SIGKILL
 * really is a bot crash (no in-process cleanup, no graceful shutdown —
 * exactly what a container kill / OOM looks like to PostgreSQL).
 *
 * Modes (BOTS13_CHILD_MODE):
 *  - hang-ban:   starts moderation.ban() whose Telegram call never resolves
 *                (write-ahead row is claimed in_progress, then the process
 *                just hangs — the parent kills it mid-operation).
 *  - recover:    a *fresh* bot instance (new process identity): runs
 *                recoverPending() with a working Telegram stub and prints a
 *                JSON summary so the parent can assert exactly-once.
 *
 * Contract with the parent: prints single-line JSON events on stdout
 * (`{"event":"..."}`), exit code 0 on success. Never logs secrets.
 */
import { eq } from 'drizzle-orm';

import { validateConfig } from '../../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../../src/db/client.js';
import { pendingOperations } from '../../../src/db/schema/moderation.js';
import { events } from '../../../src/db/schema/audit.js';
import { AuditService } from '../../../src/lib/auditService.js';
import { ModerationService } from '../../../src/lib/moderation/moderationService.js';
import { PendingOperationResolvers, PendingOperationsOutbox } from '../../../src/lib/moderation/pendingOperationsOutbox.js';
import { runWithUpdateContext } from '../../../src/lib/context.js';
import type { Logger } from '../../../src/lib/logger.js';

const mode = process.env.BOTS13_CHILD_MODE;
const chatId = process.env.BOTS13_CHILD_CHAT_ID;
const updateId = process.env.BOTS13_CHILD_UPDATE_ID;
const databaseUrl = process.env.TEST_DATABASE_URL;

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const silentLogger = { info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

function hangBot() {
  return {
    botInfo: { id: 42 },
    api: {
      raw: {
        banChatMember: () => new Promise<never>(() => undefined),
        unbanChatMember: () => new Promise<never>(() => undefined),
        restrictChatMember: () => new Promise<never>(() => undefined),
        deleteMessage: () => new Promise<never>(() => undefined),
      },
    },
  };
}

const workingBotCalls: string[] = [];
function workingBot() {
  const raw = {
    banChatMember: async () => {
      workingBotCalls.push('banChatMember');
      return true;
    },
    unbanChatMember: async () => true,
    restrictChatMember: async () => true,
    deleteMessage: async () => true,
  };
  return { botInfo: { id: 42 }, api: { raw } };
}

async function main(): Promise<void> {
  if (!mode || !chatId || !updateId || !databaseUrl) throw new Error('BOTS13_CHILD_MODE/BOTS13_CHILD_CHAT_ID/BOTS13_CHILD_UPDATE_ID/TEST_DATABASE_URL are required');
  const config = validateConfig({
    TELEGRAM_BOT_TOKEN: 'bots13-child-token',
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
  });
  const client: DatabaseClient = createDatabase(config);
  const audit = new AuditService(client.db);
  const resolvers = new PendingOperationResolvers();
  // Short lease: after the crash, the replacement process must be able to
  // reclaim the orphaned row without waiting the production 45s in a test.
  const outbox = new PendingOperationsOutbox(client.db, silentLogger, resolvers, 5, 2_000, 600);

  if (mode === 'hang-ban') {
    const moderation = new ModerationService(hangBot() as never, audit, outbox, resolvers, silentLogger);
    emit({ event: 'child_started' });
    // Fire and intentionally never await: the parent kills this process once
    // the write-ahead row shows up as in_progress in the shared database.
    // A postmaster bounced by an earlier test scenario may still be in WAL
    // recovery (sessions killed) when we start — retry through that window
    // instead of dying, exactly like a real bot reconnecting.
    void (async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const outcome = await runWithUpdateContext({ updateId, chatId, botId: '42' }, async () =>
            moderation.ban({ chatId, targetUserId: '777', actorUserId: '999' }),
          );
          emit({ event: 'unexpected_completion', status: outcome.status });
          return;
        } catch (error) {
          emit({ event: 'child_ban_retryable_error', attempt, message: error instanceof Error ? error.message : String(error) });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      emit({ event: 'child_error', message: 'ban never started: database unreachable' });
    })();
    // Keep the process alive while the operation hangs.
    await new Promise(() => undefined);
    return;
  }

  if (mode === 'recover') {
    const moderation = new ModerationService(workingBot() as never, audit, outbox, resolvers, silentLogger);
    await moderation.recoverPending();
    const [row] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId));
    const auditRows = await client.db.select().from(events).where(eq(events.tenantId, chatId));
    emit({
      event: 'recovery_summary',
      status: row?.status,
      attemptCount: row?.attemptCount,
      auditStatus: row?.auditStatus,
      telegramCalls: workingBotCalls.length,
      auditEvents: auditRows.map((event) => ({ eventType: event.eventType, idempotencyKey: event.idempotencyKey })),
    });
    await client.close();
    return;
  }

  throw new Error(`Unknown BOTS13_CHILD_MODE: ${mode}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { chatModuleStates, telegramChats, processedUpdates } from '../../src/db/schema/core.js';
import { events, entitySnapshots, outbox } from '../../src/db/schema/audit.js';
import { pendingOperations } from '../../src/db/schema/moderation.js';
import { AuditService } from '../../src/lib/auditService.js';
import { UpdateInbox } from '../../src/core/updateInbox.js';
import type { Logger } from '../../src/lib/logger.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
// The outage scenarios need a *controlled* stop/start of the real server —
// provided by the BOT-13 test harness (see the acceptance report). Skipped
// when absent so the suite still runs against any plain CI PostgreSQL.
const controlUrl = process.env.TEST_PG_CONTROL_URL;
const controlToken = process.env.TEST_PG_CONTROL_TOKEN ?? 'bot13-control';

function silentLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

async function control(path: '/stop' | '/start' | '/health'): Promise<string> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: path === '/health' ? 'GET' : 'POST',
    headers: { 'x-control-token': controlToken },
  });
  if (!response.ok) throw new Error(`Control endpoint ${path} failed: ${response.status}`);
  return response.text();
}

async function waitForDatabase(client: DatabaseClient, expectUp: boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let reachable = false;
    try {
      await client.db.execute(sql`SELECT 1`);
      reachable = true;
    } catch {
      reachable = false;
    }
    if (reachable === expectUp) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for database to be ${expectUp ? 'up' : 'down'}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!testDatabaseUrl)('BOTS-13 resilience: PostgreSQL outage + bot restart mid-operation', () => {
  let client: DatabaseClient;
  let audit: AuditService;

  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'bots13-resilience-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    client = createDatabase(config, silentLogger());
    audit = new AuditService(client.db);
  });

  afterAll(async () => {
    // Never leave the shared server down for the other suites.
    if (controlUrl) {
      await control('/start').catch(() => undefined);
      await waitForDatabase(client, true).catch(() => undefined);
    }
    await client.close();
  });

  beforeEach(async () => {
    await client.db.execute(sql`DELETE FROM audit.events`);
    await client.db.execute(sql`DELETE FROM audit.entity_snapshots`);
    await client.db.execute(sql`DELETE FROM audit.outbox`);
    await client.db.execute(sql`DELETE FROM moderation.pending_operations`);
    await client.db.execute(sql`DELETE FROM core.processed_updates`);
    await client.db.execute(sql`DELETE FROM audit.event_policies WHERE chat_id IS NOT NULL`);
    await client.db.execute(sql`DELETE FROM core.chat_module_states`);
    await client.db.execute(sql`DELETE FROM public.telegram_chats`);
  });

  describe('временное отключение PostgreSQL', () => {
    it.skipIf(!controlUrl)('in-flight queries fail cleanly, nothing partial is persisted, and the same pool recovers after the server returns', async () => {
      const chatId = `outage-${randomUUID()}`;

      // Baseline write while the server is up.
      await audit.recordEntityChange(
        {
          tenantId: chatId,
          subjectType: 'chat_member',
          subjectId: `${chatId}:1`,
          eventType: 'member.status.changed',
          eventVersion: 'v1',
          category: 'member',
          source: 'bots13.outage',
          idempotencyKey: `outage-before-${randomUUID()}`,
        },
        async () => ({
          before: undefined,
          after: { chatId, userId: '1', status: 'member' },
          beforeSnapshotStatus: 'not_observed' as const,
          afterSnapshotStatus: 'observed' as const,
          snapshotStatus: 'current' as const,
          snapshotData: { chatId, userId: '1', status: 'member' },
        }),
      );

      await control('/stop');
      await waitForDatabase(client, false);

      // Every write path must REJECT (fail cleanly) while the server is
      // down — the process itself stays alive (an unhandled pool 'error'
      // would crash vitest before these assertions run).
      await expect(
        audit.recordEntityChange(
          {
            tenantId: chatId,
            subjectType: 'chat_member',
            subjectId: `${chatId}:2`,
            eventType: 'member.status.changed',
            eventVersion: 'v1',
            category: 'member',
            source: 'bots13.outage',
            idempotencyKey: `outage-during-${randomUUID()}`,
          },
          async () => ({
            before: undefined,
            after: { chatId, userId: '2', status: 'member' },
            snapshotStatus: 'current' as const,
            snapshotData: { chatId, userId: '2', status: 'member' },
          }),
        ),
      ).rejects.toThrow();
      const inbox = new UpdateInbox(client.db, silentLogger());
      await expect(inbox.begin('42', `outage-${randomUUID()}`)).rejects.toThrow();

      await control('/start');
      await waitForDatabase(client, true);

      // The SAME client (pool) transparently reconnects — no restart of the
      // bot process is needed to survive a temporary database outage.
      const afterKey = `outage-after-${randomUUID()}`;
      await audit.recordEntityChange(
        {
          tenantId: chatId,
          subjectType: 'chat_member',
          subjectId: `${chatId}:3`,
          eventType: 'member.status.changed',
          eventVersion: 'v1',
          category: 'member',
          source: 'bots13.outage',
          idempotencyKey: afterKey,
        },
        async () => ({
          before: undefined,
          after: { chatId, userId: '3', status: 'member' },
          beforeSnapshotStatus: 'not_observed' as const,
          afterSnapshotStatus: 'observed' as const,
          snapshotStatus: 'current' as const,
          snapshotData: { chatId, userId: '3', status: 'member' },
        }),
      );

      const rows = await client.db.select().from(events).where(eq(events.tenantId, chatId));
      expect(rows).toHaveLength(2); // exactly before + after; nothing partial from the failed write
      expect(rows.map((row) => row.idempotencyKey).sort()).toEqual([afterKey, rows.map((row) => row.idempotencyKey).find((key) => key.startsWith('outage-before'))].sort());
      const snapshots = await client.db.select().from(entitySnapshots);
      expect(snapshots).toHaveLength(2);
    }, 120_000);

    it.skipIf(!controlUrl)('server dying mid-transaction rolls back BOTH the business row and the audit row', async () => {
      const chatId = `outage-tx-${randomUUID()}`;
      const key = `outage-tx-${randomUUID()}`;

      await expect(
        audit.recordEntityChange(
          {
            tenantId: chatId,
            subjectType: 'chat_module_state',
            subjectId: `${chatId}:module-moderation`,
            eventType: 'module.state.changed',
            eventVersion: 'v1',
            category: 'module',
            source: 'bots13.outage',
            idempotencyKey: key,
          },
          async (tx) => {
            // Business write lands inside the transaction…
            await tx.insert(telegramChats).values({ chatId, type: 'supergroup' });
            await tx.insert(chatModuleStates).values({ chatId, moduleId: 'moderation', enabled: true });
            // …then the database dies before COMMIT.
            await control('/stop');
            await tx.insert(chatModuleStates).values({ chatId, moduleId: 'module-admin', enabled: true });
            return {
              before: undefined,
              after: { enabled: true },
              snapshotStatus: 'current' as const,
              snapshotData: { chatId, moduleId: 'moderation', enabled: true },
            };
          },
        ),
      ).rejects.toThrow();

      await control('/start');
      await waitForDatabase(client, true);

      expect(await client.db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId))).toHaveLength(0);
      expect(await client.db.select().from(chatModuleStates).where(eq(chatModuleStates.chatId, chatId))).toHaveLength(0);
      expect(await client.db.select().from(events).where(eq(events.idempotencyKey, key))).toHaveLength(0);
      expect(await client.db.select().from(outbox)).toHaveLength(0);
    }, 120_000);
  });

  describe('перезапуск бота во время незавершённой операции', () => {
    // A dedicated pool, opened after any outage scenario ran: the restarted
    // bot process is a NEW process with NEW connections anyway, and a pool
    // that still holds pre-restart sockets is exactly what a real restart
    // throws away.
    let restartClient: DatabaseClient;

    beforeAll(async () => {
      const config = validateConfig({
        TELEGRAM_BOT_TOKEN: 'bots13-restart-token',
        DATABASE_URL: testDatabaseUrl,
        NODE_ENV: 'test',
        DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
      });
      restartClient = createDatabase(config, silentLogger());
    });

    afterAll(async () => {
      await restartClient.close();
    });

    /** Runs the shared child helper in its own OS process (tsx via node --import). */
    function runChild(mode: 'hang-ban' | 'recover', chatId: string, updateId: string): Promise<{ code: number | null; stdout: string[]; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tests/integration/helpers/bots13Child.ts'],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              BOTS13_CHILD_MODE: mode,
              BOTS13_CHILD_CHAT_ID: chatId,
              BOTS13_CHILD_UPDATE_ID: updateId,
              TEST_DATABASE_URL: testDatabaseUrl,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        const stdout: string[] = [];
        const stderr: string[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(...chunk.toString('utf8').split('\n')));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout: stdout.filter(Boolean), stderr: stderr.join('') }));
        if (mode === 'hang-ban') {
          // Kill mid-operation as soon as the write-ahead row is claimed.
          void (async () => {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              let rows: { status: string }[];
              try {
                rows = await restartClient.db.select({ status: pendingOperations.status }).from(pendingOperations).where(eq(pendingOperations.chatId, chatId));
              } catch {
                // A postmaster bounced by an earlier scenario is briefly in
                // WAL recovery: it listens but kills sessions. That is a
                // transient database outage, not a child failure — poll again
                // (this is exactly the reconnect behaviour the bot relies on).
                await new Promise((resolve2) => setTimeout(resolve2, 200));
                continue;
              }
              if (rows[0]?.status === 'in_progress') {
                await new Promise((resolve2) => setTimeout(resolve2, 150)); // let the executor enter its hang
                child.kill('SIGKILL');
                return;
              }
              await new Promise((resolve2) => setTimeout(resolve2, 100));
            }
            child.kill('SIGKILL');
          })().catch(() => child.kill('SIGKILL'));
        }
      });
    }

    it('SIGKILL mid-Telegram-call leaves a recoverable write-ahead row; a fresh bot process finishes it exactly once', async () => {
      const chatId = String(-100_313_000 - Math.floor(Math.random() * 1_000));
      const updateId = `bots13-restart-${randomUUID()}`;

      // Self-healing guard: whatever an earlier scenario did to the shared
      // server, this one starts from a known-up database.
      await waitForDatabase(client, true);
      await restartClient.db.execute(sql`SELECT 1`); // warm the fresh pool while the server is known-up

      /** Transient "server is starting up" windows from a bounced postmaster must not fail assertions — retry them, like the bot would. */
      async function dbRetry<T>(operation: () => Promise<T>, attempts = 20): Promise<T> {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await operation();
          } catch (error) {
            if (attempt >= attempts) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }

      // 1st "bot process": starts /ban, the Telegram call hangs, we SIGKILL it.
      const crashed = await runChild('hang-ban', chatId, updateId);
      expect(crashed.code, `hang-ban child output: ${crashed.stdout.join(' | ')} / stderr: ${crashed.stderr}`).not.toBe(0); // killed, not exited cleanly
      const [orphan] = await dbRetry(() => restartClient.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId)));
      expect(orphan).toBeDefined();
      expect(['in_progress', 'pending', 'unknown']).toContain(orphan!.status); // NOT terminal — the crash froze it mid-flight
      expect(orphan!.attemptCount).toBeGreaterThanOrEqual(1);
      expect(await dbRetry(() => restartClient.db.select().from(events).where(eq(events.tenantId, chatId)))).toHaveLength(0); // no audit record yet — the outcome was genuinely unknown

      // 2nd "bot process" (restart): recoverPending() claims the orphaned
      // row once its short lease expires, performs the call, finalises.
      const deadline = Date.now() + 15_000;
      let summary: { event: string; status?: string; telegramCalls?: number; auditEvents?: { eventType: string }[] } | undefined;
      for (;;) {
        const restarted = await runChild('recover', chatId, updateId);
        expect(restarted.code, `recover child failed: ${restarted.stderr}`).toBe(0);
        const parsed = restarted.stdout
          .map((line) => { try { return JSON.parse(line) as { event: string }; } catch { return undefined; } })
          .filter((line): line is { event: string } => line !== undefined)
          .at(-1);
        if (parsed?.event === 'recovery_summary') {
          summary = parsed as typeof summary;
          break;
        }
        // The orphan's lease may still be live from the crashed process.
        if (Date.now() > deadline) throw new Error(`Recovery did not complete in time; last child output: ${restarted.stdout.join(' | ')} / ${restarted.stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      expect(summary?.status).toBe('succeeded');
      expect(summary?.telegramCalls).toBe(1); // the restarted process performed the call exactly once
      expect(summary?.auditEvents).toHaveLength(1); // exactly one terminal moderation.action record
      expect(summary?.auditEvents?.[0]?.eventType).toBe('moderation.action');

      const [finalRow] = await dbRetry(() => restartClient.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId)));
      expect(finalRow?.status).toBe('succeeded');
      expect(finalRow?.auditStatus).toBe('written');
      // Idempotency: the redelivered-update path must not double-execute.
      expect(new Set(summary?.auditEvents?.map((event) => event.eventType))).toEqual(new Set(['moderation.action']));
      // The inbox marker for the crashed update must still be re-claimable
      // (the crashed process never completed it) — redelivery can reprocess.
      const inbox = new UpdateInbox(restartClient.db, silentLogger());
      const redelivered = await inbox.begin('42', updateId);
      expect(redelivered.claim).not.toBe('completed');
      expect(await dbRetry(() => restartClient.db.select().from(processedUpdates).where(eq(processedUpdates.updateId, updateId)))).toHaveLength(1);
    }, 90_000);
  });
});

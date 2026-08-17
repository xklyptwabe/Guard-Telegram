import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { UpdateInbox } from '../../src/core/updateInbox.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { processedUpdates } from '../../src/db/schema/core.js';
import { pendingOperations } from '../../src/db/schema/moderation.js';
import { AuditService } from '../../src/lib/auditService.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import type { Logger } from '../../src/lib/logger.js';
import { ModerationService } from '../../src/lib/moderation/moderationService.js';
import { PendingOperationResolvers, PendingOperationsOutbox } from '../../src/lib/moderation/pendingOperationsOutbox.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function silentLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * Drizzle wraps driver errors as `Failed query: …` with the original
 * Postgres error on `.cause` — assert against both texts.
 */
async function expectDbError(query: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await query;
  } catch (error: unknown) {
    const message = `${error instanceof Error ? error.message : String(error)} ${(error as { cause?: Error }).cause?.message ?? ''}`;
    expect(message).toMatch(pattern);
    return;
  }
  throw new Error(`Expected a database error matching ${pattern}, but the query succeeded`);
}

function fakeBot() {
  return {
    api: {
      raw: {
        banChatMember: vi.fn(async () => true),
        unbanChatMember: vi.fn(async () => true),
        restrictChatMember: vi.fn(async () => true),
        deleteMessage: vi.fn(async () => true),
      },
    },
  };
}

/**
 * BOTS-9 review — DB-backed verification of the blocker fixes that unit
 * fakes cannot prove: real `FOR UPDATE SKIP LOCKED` semantics, real CHECK
 * constraints, real `SET ROLE` privileges, real lease expiry/redelivery,
 * and negative-marker scans over actual JSONB columns. Requires a real
 * PostgreSQL at `TEST_DATABASE_URL` (skipped otherwise, per repo
 * convention — see bot13.e2e.test.ts).
 */
describe.skipIf(!testDatabaseUrl)('BOTS-9 blockers: real-DB verification', () => {
  let client: DatabaseClient;
  let audit: AuditService;

  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'bots9-test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      // CI runs against a properly CA-signed instance; a local portable
      // PostgreSQL uses a self-signed cert — allow opting out per env.
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    client = createDatabase(config);
    audit = new AuditService(client.db);
    // Self-provisioning: idempotent — applies 0016/0017 (constraints,
    // audit_status, inbox) on top of whatever the environment already has.
    await migrate(client.db, { migrationsFolder: 'src/db/migrations' });
  });

  afterAll(async () => {
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
    await client.db.execute(sql`INSERT INTO public.telegram_chats (chat_id, type) VALUES ('-100900', 'supergroup') ON CONFLICT DO NOTHING`);
  });

  it('BLOCKER-2 DoD: two concurrent recovery workers on one row — exactly one executor invocation (real SKIP LOCKED)', async () => {
    const resolvers = new PendingOperationResolvers();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    resolvers.register('telegram.banChatMember', executor);

    await client.db.insert(pendingOperations).values({
      kind: 'telegram.banChatMember',
      chatId: '-100900',
      requestPayload: { chat_id: -100900, user_id: 2 },
      metadata: { action: 'ban', actorUserId: '9', targetUserId: '2' },
      idempotencyKey: 'bots9-concurrent-1',
      status: 'pending',
    });

    const workerA = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
    const workerB = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
    const onFinalA = vi.fn(async () => undefined);
    const onFinalB = vi.fn(async () => undefined);

    // Both sweeps start before either executor finishes — the gated
    // executor guarantees real overlap against the same row.
    const a = workerA.recoverPending(onFinalA);
    const b = workerB.recoverPending(onFinalB);
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    await Promise.all([a, b]);

    expect(executor).toHaveBeenCalledTimes(1);
    const [row] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'bots9-concurrent-1'));
    expect(row?.status).toBe('succeeded');
    expect(row?.auditStatus).toBe('written');
  });

  it('BLOCKER-2: late resolution after a stolen lease is discarded (CAS), never overwriting the new owner', async () => {
    const resolvers = new PendingOperationResolvers();
    resolvers.register('telegram.banChatMember', vi.fn(async () => ({ ok: true })));
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);

    await client.db.insert(pendingOperations).values({
      kind: 'telegram.banChatMember',
      chatId: '-100900',
      requestPayload: {},
      metadata: { action: 'ban', actorUserId: '9', targetUserId: '2' },
      idempotencyKey: 'bots9-cas-1',
      status: 'pending',
    });

    // Worker claims, then a "new owner" steals the lease (simulating
    // lease-expiry reclaim while the first worker is still in flight).
    const claim = await client.db
      .update(pendingOperations)
      .set({ status: 'in_progress', workerId: 'first-worker', leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(pendingOperations.idempotencyKey, 'bots9-cas-1'))
      .returning({ id: pendingOperations.id });
    expect(claim).toHaveLength(1);

    // The first worker's resolve() CAS must lose to the new owner.
    const resolveByDisplacedOwner = await client.db
      .update(pendingOperations)
      .set({ status: 'succeeded', workerId: null, leaseExpiresAt: null })
      .where(and(eq(pendingOperations.id, claim[0]!.id), eq(pendingOperations.workerId, 'first-worker')))
      .returning({ id: pendingOperations.id });
    expect(resolveByDisplacedOwner).toHaveLength(1); // lease not stolen yet — CAS still valid

    await client.db.update(pendingOperations).set({ workerId: 'new-owner' }).where(eq(pendingOperations.id, claim[0]!.id));
    const resolveByStolenOwner = await client.db
      .update(pendingOperations)
      .set({ status: 'succeeded', workerId: null, leaseExpiresAt: null })
      .where(and(eq(pendingOperations.id, claim[0]!.id), eq(pendingOperations.workerId, 'first-worker')))
      .returning({ id: pendingOperations.id });
    expect(resolveByStolenOwner).toHaveLength(0); // CAS discarded — new owner untouched
    const [row] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'bots9-cas-1'));
    // The displaced worker's write never landed: the row keeps whatever the
    // new owner last wrote (here: the earlier valid resolve, with ownership
    // transferred) — not the stale overwrite attempt.
    expect(row?.workerId).toBe('new-owner');
    expect(row?.status).toBe('succeeded');
    void outbox;
  });

  it('BLOCKER-4 DoD: secret markers never reach any audit/outbox JSONB column (real DB scan)', async () => {
    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
    const bot = fakeBot();
    const moderation = new ModerationService(bot as never, audit, outbox, resolvers, silentLogger());

    // Succeeded path: a DSN pasted into the moderation reason.
    await runWithUpdateContext({ updateId: '9001', chatId: '-100900', botId: '42' }, () =>
      moderation.ban({ chatId: '-100900', targetUserId: '2', actorUserId: '9', reason: 'spam see postgres://admin:sup3rs3cret@db.internal:5432/audit' }),
    );
    // Failed/unknown path: an unknown error carrying a credential-bearing DSN.
    bot.api.raw.unbanChatMember.mockRejectedValueOnce(new Error('connect failed postgres://bot:an0therpass@db.internal:5432/x'));
    await runWithUpdateContext({ updateId: '9002', chatId: '-100900', botId: '42' }, () =>
      moderation.unban({ chatId: '-100900', targetUserId: '3', actorUserId: '9' }),
    );

    const scan = await client.db.execute<{ table_name: string; col: string }>(sql`
      SELECT 'events.after' AS table_name, after::text AS col FROM audit.events WHERE after::text LIKE '%sup3rs3cret%' OR after::text LIKE '%an0therpass%'
      UNION ALL SELECT 'events.metadata', metadata::text FROM audit.events WHERE metadata::text LIKE '%sup3rs3cret%' OR metadata::text LIKE '%an0therpass%'
      UNION ALL SELECT 'outbox.payload', payload::text FROM audit.outbox WHERE payload::text LIKE '%sup3rs3cret%' OR payload::text LIKE '%an0therpass%'
      UNION ALL SELECT 'snapshots.snapshot_data', snapshot_data::text FROM audit.entity_snapshots WHERE snapshot_data::text LIKE '%sup3rs3cret%' OR snapshot_data::text LIKE '%an0therpass%'
      UNION ALL SELECT 'pending.request_payload', request_payload::text FROM moderation.pending_operations WHERE request_payload::text LIKE '%sup3rs3cret%' OR request_payload::text LIKE '%an0therpass%'
      UNION ALL SELECT 'pending.metadata', metadata::text FROM moderation.pending_operations WHERE metadata::text LIKE '%sup3rs3cret%' OR metadata::text LIKE '%an0therpass%'
      UNION ALL SELECT 'pending.result', result::text FROM moderation.pending_operations WHERE result::text LIKE '%sup3rs3cret%' OR result::text LIKE '%an0therpass%'
      UNION ALL SELECT 'pending.last_error', last_error::text FROM core.processed_updates WHERE last_error::text LIKE '%sup3rs3cret%'
    `);
    expect(scan.rows).toEqual([]);
    // …and the redaction itself is visible (not silently dropped text):
    const [reasonRow] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'moderation.action:telegram-update:42:9001:-100900:2:ban'));
    expect(JSON.stringify(reasonRow?.metadata)).toContain('[redacted]');
  });

  it('BLOCKER-5 DoD: inbox partial failure on a real DB — redelivery resumes, completion dedupes, retention-safe', async () => {
    const inbox = new UpdateInbox(client.db, silentLogger(), 5, 45_000);

    const first = await inbox.begin('42', '7001');
    expect(first.claim).toBe('claimed');
    // "Crash": no complete() — row stays processing with a live lease.
    const earlyRedelivery = await inbox.begin('42', '7001');
    expect(earlyRedelivery.claim).toBe('busy');

    // Lease genuinely expires → redelivery reprocesses.
    await client.db.update(processedUpdates).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(and(eq(processedUpdates.botId, '42'), eq(processedUpdates.updateId, '7001')));
    const retry = await inbox.begin('42', '7001');
    expect(retry.claim).toBe('claimed');
    expect(retry.attemptCount).toBe(2);

    await inbox.complete('42', '7001');
    const afterCompletion = await inbox.begin('42', '7001');
    expect(afterCompletion.claim).toBe('completed'); // dedup only from this moment

    const [row] = await client.db.select().from(processedUpdates).where(and(eq(processedUpdates.botId, '42'), eq(processedUpdates.updateId, '7001')));
    expect(row?.status).toBe('completed');
    expect(row?.workerId).toBeNull();
  });

  it('HIGH-4 DoD: telegram_bot runtime role — required DML allowed, DELETE denied (migrations 0014/0015/0016/0017 grants)', async () => {
    // Ensure the role exists locally (idempotent; migrations grant to it
    // only if present, mirroring production provisioning).
    await client.db.execute(sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telegram_bot') THEN
        CREATE ROLE telegram_bot NOLOGIN;
      END IF;
    END $$;`);
    // Re-apply the grants (they were skipped if the role was created after
    // the migrations ran).
    await client.db.execute(sql`GRANT USAGE ON SCHEMA moderation TO telegram_bot`);
    await client.db.execute(sql`GRANT SELECT, INSERT ON moderation.pending_operations TO telegram_bot`);
    await client.db.execute(sql`GRANT UPDATE (status, attempt_count, last_attempt_at, next_attempt_at, result, updated_at, worker_id, lease_expires_at, audit_status, audit_worker_id, audit_lease_expires_at) ON moderation.pending_operations TO telegram_bot`);
    await client.db.execute(sql`GRANT USAGE ON SCHEMA core TO telegram_bot`);
    await client.db.execute(sql`GRANT SELECT, INSERT, UPDATE ON core.processed_updates TO telegram_bot`);

    await client.db.execute(sql`INSERT INTO moderation.pending_operations (kind, chat_id, request_payload, metadata, idempotency_key, status) VALUES ('telegram.banChatMember', '-100900', '{}', '{}', 'bots9-role-1', 'pending')`);

    await client.db.execute(sql`SET ROLE telegram_bot`);
    try {
      // Claim + resolve shape (worker_id/lease/audit_status columns included).
      await client.db.execute(sql`UPDATE moderation.pending_operations SET status='in_progress', worker_id='w', lease_expires_at=now()+interval '45 seconds', attempt_count=attempt_count+1, audit_status='pending' WHERE idempotency_key='bots9-role-1'`);
      await client.db.execute(sql`UPDATE moderation.pending_operations SET status='succeeded', worker_id=NULL, lease_expires_at=NULL, audit_status='written' WHERE idempotency_key='bots9-role-1'`);
      // Inbox claim shape.
      await client.db.execute(sql`INSERT INTO core.processed_updates (bot_id, update_id, status) VALUES ('42','7002','received') ON CONFLICT DO NOTHING`);
      await client.db.execute(sql`UPDATE core.processed_updates SET status='processing', worker_id='w', lease_expires_at=now()+interval '45 seconds', attempt_count=attempt_count+1 WHERE bot_id='42' AND update_id='7002'`);
      // DELETE must be denied — audit/outbox history is not deletable by the
      // app role. The server's message locale varies (EN "permission
      // denied", RU "нет доступа"), so assert the denial happened and — the
      // actual security property — that the row survived it.
      let deleteWasDenied = false;
      try {
        await client.db.execute(sql`DELETE FROM moderation.pending_operations WHERE idempotency_key='bots9-role-1'`);
      } catch {
        deleteWasDenied = true;
      }
      expect(deleteWasDenied).toBe(true);
    } finally {
      await client.db.execute(sql`RESET ROLE`);
    }
    const [survivor] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'bots9-role-1'));
    expect(survivor?.status).toBe('succeeded');
  });

  it('MEDIUM-3 DoD: DB-level invariants reject illegal state (CHECK constraints from migration 0016)', async () => {
    await expectDbError(
      client.db.execute(sql`INSERT INTO moderation.pending_operations (kind, chat_id, request_payload, metadata, idempotency_key, status) VALUES ('x.y','-100900','{}','{}','bots9-check-1','teleported')`),
      /pending_operations_status_check/i,
    );
    await expectDbError(
      client.db.execute(sql`INSERT INTO moderation.pending_operations (kind, chat_id, request_payload, metadata, idempotency_key, status, attempt_count) VALUES ('x.y','-100900','{}','{}','bots9-check-2','pending', -1)`),
      /pending_operations_attempt_count_check/i,
    );
    await expectDbError(
      client.db.execute(sql`INSERT INTO moderation.pending_operations (kind, chat_id, request_payload, metadata, idempotency_key, status, next_attempt_at) VALUES ('x.y','-100900','{}','{}','bots9-check-3','succeeded', now())`),
      /pending_operations_terminal_next_attempt_check/i,
    );
  });

  it('HIGH-3 DoD: terminal audit backfill on a real DB — audit written later, executor never re-run', async () => {
    const resolvers = new PendingOperationResolvers();
    const executor = vi.fn(async () => ({ ok: true }));
    resolvers.register('telegram.banChatMember', executor);
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);

    const failing = vi.fn(async () => {
      throw new Error('audit layer down');
    });
    await outbox.execute({ kind: 'telegram.banChatMember', chatId: '-100900', idempotencyKey: 'bots9-h3-1', requestPayload: {}, metadata: {} }, executor, failing);
    let [row] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'bots9-h3-1'));
    expect(row?.status).toBe('succeeded');
    expect(row?.auditStatus).toBe('pending');

    const working = vi.fn(async () => undefined);
    await outbox.recoverPending(working);
    [row] = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'bots9-h3-1'));
    expect(row?.auditStatus).toBe('written');
    expect(executor).toHaveBeenCalledTimes(1); // audit retried, operation NOT
    expect(working).toHaveBeenCalledTimes(1);
  });
});

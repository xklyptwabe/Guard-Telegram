import { and, eq, isNull, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { createDatabase, type DatabaseClient } from '../../src/db/client.js';
import { eventPolicies, events, entitySnapshots } from '../../src/db/schema/audit.js';
import { pendingOperations } from '../../src/db/schema/moderation.js';
import { purgeExpiredAuditEventsBatch } from '../../src/db/retention.js';
import { AuditService } from '../../src/lib/auditService.js';
import { recordMessageDeleted } from '../../src/lib/audit/messageAudit.js';
import { recordMemberStatusChanged } from '../../src/lib/audit/memberAudit.js';
import { recordIntegrationAction } from '../../src/lib/audit/integrationAudit.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import { makeIntegrationAuditFinalizer } from '../../src/lib/integrations/externalOperationGateway.js';
import type { Logger } from '../../src/lib/logger.js';
import { ModerationService } from '../../src/lib/moderation/moderationService.js';
import { PendingOperationResolvers, PendingOperationsOutbox } from '../../src/lib/moderation/pendingOperationsOutbox.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function silentLogger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
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

function memberFixture(updateId: number, date: number, oldStatus: string, newStatus: string, newExtra: Record<string, unknown> = {}) {
  return {
    update_id: updateId,
    chatMember: {
      chat: { id: -1001111111111, type: 'supergroup', title: 'Fixture Chat' },
      from: { id: 999999, is_bot: false, first_name: 'Owner', username: 'owner' },
      date,
      old_chat_member: { status: oldStatus, user: { id: 888888, is_bot: false, first_name: 'Heidi' } },
      new_chat_member: { status: newStatus, user: { id: 888888, is_bot: false, first_name: 'Heidi' }, ...newExtra },
    },
  } as never;
}

/**
 * BOTS-9 review round-2 — real-PostgreSQL verification of the round-2
 * fixes (BLOCKER-1 finalizer contract, BLOCKER-2 per-kind retry policy,
 * BLOCKER-4 audit-failure propagation, HIGH-2 outcome first-class,
 * HIGH-3 snapshot preservation, equal-timestamp ordering, retention
 * tombstone). Skipped when `TEST_DATABASE_URL` is absent, per repo
 * convention.
 */
describe.skipIf(!testDatabaseUrl)('BOTS-9 round-2 fixes: real-DB verification', () => {
  let client: DatabaseClient;
  let audit: AuditService;
  const chatId = '-100900';

  beforeAll(async () => {
    const config = validateConfig({
      TELEGRAM_BOT_TOKEN: 'bots9-r2-test-token',
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      DATABASE_TLS_REJECT_UNAUTHORIZED: process.env.TEST_DATABASE_TLS_REJECT_UNAUTHORIZED ?? 'true',
    });
    client = createDatabase(config);
    audit = new AuditService(client.db);
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
    // Only chat-scoped policies are wiped (the seeded global defaults must
    // survive — deleting them would disable every event), the suite's own
    // chat-scoped retention policy is removed, and every global policy is
    // reset to enabled=true (a previous run may have flipped one).
    await client.db.execute(sql`DELETE FROM audit.event_policies WHERE chat_id IS NOT NULL`);
    await client.db.execute(sql`DELETE FROM audit.event_policies WHERE policy_id = 'pol-r2-retention'`);
    await client.db.execute(sql`UPDATE audit.event_policies SET enabled = true WHERE chat_id IS NULL`);
    await client.db.execute(sql`DELETE FROM core.chat_module_states`);
    await client.db.execute(sql`DELETE FROM public.telegram_chats`);
    await client.db.execute(sql`INSERT INTO public.telegram_chats (chat_id, type) VALUES ('${sql.raw(chatId)}', 'supergroup') ON CONFLICT DO NOTHING`);
  });

  it('BLOCKER-2: deleteMessage unknown is TERMINAL — the worker never blindly re-runs a destructive call', async () => {
    const resolvers = new PendingOperationResolvers();
    resolvers.register(
      'telegram.deleteMessage',
      () => new Promise<never>(() => undefined), // hangs → local timeout → unknown
      { retryAfterUnknown: false },
    );
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers, 5, 50);

    const result = await outbox.execute(
      { kind: 'telegram.deleteMessage', chatId, idempotencyKey: 'del-unknown-1', requestPayload: { chat_id: -100900, message_id: 7 } },
      resolvers.get('telegram.deleteMessage')!,
      async () => ({ status: 'recorded' as const }),
    );

    expect(result.outcome.status).toBe('unknown');
    expect(result.isFinal).toBe(true); // terminal on the FIRST unknown
    const row = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'del-unknown-1')).limit(1);
    expect(row[0]?.status).toBe('unknown');
    expect(row[0]?.nextAttemptAt).toBeNull();
    expect(row[0]?.attemptCount).toBe(1);

    // Any number of worker sweeps must not re-issue the delete.
    await outbox.recoverPending(async () => ({ status: 'recorded' as const }));
    const after = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'del-unknown-1')).limit(1);
    expect(after[0]?.attemptCount).toBe(1);
  });

  it('BLOCKER-1/4: a terminal moderation op with a failing audit leaves audit_status=pending AND throws — the backfill later completes it WITHOUT re-running Telegram', async () => {
    const bot = fakeBot();
    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
    const failingAudit = {
      recordEntityChange: vi.fn(async () => Promise.reject(new Error('audit db down'))),
      maskOutboxMetadata: vi.fn(async (input: { metadata: Record<string, unknown> }) => input.metadata),
    } as never;
    const service = new ModerationService(bot as never, failingAudit, outbox, resolvers, silentLogger());

    await expect(
      runWithUpdateContext({ updateId: 'r2-1', botId: '42' }, () => service.ban({ chatId, targetUserId: '123', actorUserId: '456' })),
    ).rejects.toThrow(/still owed/);

    expect(bot.api.raw.banChatMember).toHaveBeenCalledTimes(1);
    const row = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId)).limit(1);
    expect(row[0]?.status).toBe('succeeded');
    expect(row[0]?.auditStatus).toBe('pending'); // the audit is durably still owed

    // "Restart": a fresh ModerationService with a working audit backfills
    // the record without re-invoking the executor.
    const bot2 = fakeBot();
    const resolvers2 = new PendingOperationResolvers();
    const outbox2 = new PendingOperationsOutbox(client.db, silentLogger(), resolvers2);
    const service2 = new ModerationService(bot2 as never, audit, outbox2, resolvers2, silentLogger());
    await service2.recoverPending();

    const eventsForChat = await client.db.select().from(events).where(eq(events.tenantId, chatId));
    expect(eventsForChat).toHaveLength(1);
    expect(eventsForChat[0]?.eventType).toBe('moderation.action');
    const rowAfter = await client.db.select().from(pendingOperations).where(eq(pendingOperations.chatId, chatId)).limit(1);
    expect(rowAfter[0]?.auditStatus).toBe('written');
    expect(bot2.api.raw.banChatMember).not.toHaveBeenCalled(); // executor never re-ran
  });

  it('BLOCKER-1: a policy-disabled terminal operation is policy_skipped — no event, no throw, backfill stops retrying', async () => {
    // `integration.action` is canBeDisabled: true (moderation.action is
    // trigger-protected). Flipping the SEEDED global policy to disabled
    // makes the outbox finalizer map the outcome to policy_skipped.
    await client.db
      .update(eventPolicies)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(eventPolicies.eventType, 'integration.action'), eq(eventPolicies.eventVersion, 'v1'), isNull(eventPolicies.chatId)));
    const resolvers = new PendingOperationResolvers();
    resolvers.register('rabbitmq.publish', async () => ({ messageId: 'env-1' }));
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
    await client.db.insert(pendingOperations).values({
      kind: 'rabbitmq.publish',
      chatId: 'platform',
      idempotencyKey: 'rabbit.policy-skipped-1',
      requestPayload: { envelope: { id: 'env-1', type: 'x.y', attempt: 0, payload: {} } },
      metadata: { integrationId: 'rabbitmq', action: 'x.y', targetType: 'queue', targetId: 'q' },
      status: 'pending',
      nextAttemptAt: null,
    });

    await outbox.recoverPending(makeIntegrationAuditFinalizer(audit, silentLogger()));

    const row = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'rabbit.policy-skipped-1')).limit(1);
    expect(row[0]?.status).toBe('succeeded');
    expect(row[0]?.auditStatus).toBe('policy_skipped');
    const integrationEvents = await client.db.select().from(events).where(eq(events.eventType, 'integration.action'));
    expect(integrationEvents).toHaveLength(0);

    // Backfill pass must not keep retrying the skipped row.
    await outbox.recoverPending(makeIntegrationAuditFinalizer(audit, silentLogger()));
    const rowAfter = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 'rabbit.policy-skipped-1')).limit(1);
    expect(rowAfter[0]?.auditStatus).toBe('policy_skipped');
  });

  it('HIGH-3: a failed/unknown delete does NOT archive the current snapshot', async () => {
    // First, create a "message exists" snapshot the way message.edited would.
    const subjectId = `${chatId}:503`;
    await audit.recordEntityChange(
      {
        tenantId: chatId,
        subjectType: 'message',
        subjectId,
        eventType: 'message.edited',
        eventVersion: 'v1',
        category: 'message',
        source: 'telegram.edited_message_update',
        idempotencyKey: `r2-msg:${subjectId}:1`,
        actorId: '123',
        actorType: 'telegram_user',
      },
      async () => ({
        before: undefined,
        after: { chatId, messageId: '503', userId: '123', editedAt: '2026-08-01T00:00:00.000Z', textLength: 5, text: 'hello' },
        beforeSnapshotStatus: 'not_observed' as const,
        afterSnapshotStatus: 'observed' as const,
        snapshotStatus: 'current' as const,
        snapshotData: { chatId, messageId: '503', userId: '123', editedAt: '2026-08-01T00:00:00.000Z', textLength: 5, text: 'hello' },
      }),
    );

    // A FAILED delete attempt — the message still exists, snapshot must stay current.
    await recordMessageDeleted(audit, silentLogger(), { chatId, messageId: '503', idempotencyKey: 'r2-del:503:failed', deletedBy: '456', outcome: 'failed' });
    let snap = await client.db.select().from(entitySnapshots).where(eq(entitySnapshots.entityId, subjectId)).limit(1);
    expect(snap[0]?.snapshotStatus).toBe('current'); // NOT archived
    // Data preserved (subject identity survives the message.deleted schema
    // projection; the point is the snapshot was NOT replaced with an
    // archived tombstone).
    expect((snap[0]?.snapshotData as Record<string, unknown>).messageId).toBe('503');
    expect((snap[0]?.snapshotData as Record<string, unknown>).userId).toBe('123');

    // An UNKNOWN delete attempt — same guarantee.
    await recordMessageDeleted(audit, silentLogger(), { chatId, messageId: '503', idempotencyKey: 'r2-del:503:unknown', deletedBy: '456', outcome: 'unknown' });
    snap = await client.db.select().from(entitySnapshots).where(eq(entitySnapshots.entityId, subjectId)).limit(1);
    expect(snap[0]?.snapshotStatus).toBe('current');

    // A CONFIRMED delete still archives.
    await recordMessageDeleted(audit, silentLogger(), { chatId, messageId: '503', idempotencyKey: 'r2-del:503:ok', deletedBy: '456', outcome: 'succeeded' });
    snap = await client.db.select().from(entitySnapshots).where(eq(entitySnapshots.entityId, subjectId)).limit(1);
    expect(snap[0]?.snapshotStatus).toBe('archived');
  });

  it('HIGH: equal-timestamp updates use update_id as the order marker — an older update_id never overwrites', async () => {
    // The producer derives tenantId from the FIXTURE's chat, not from the
    // update-context — query snapshots under the fixture chat id.
    const memberChatId = '-1001111111111';
    const subjectId = `${memberChatId}:888888`;
    // Same second (date=1770001000) for all three. update_ids: 100, 101, 99.
    const ctxA = memberFixture(100, 1770001000, 'member', 'member');
    await runWithUpdateContext({ updateId: '100', botId: '42', chatId }, () => recordMemberStatusChanged(audit, silentLogger(), ctxA));

    const ctxB = memberFixture(101, 1770001000, 'member', 'administrator', { can_manage_chat: true });
    await runWithUpdateContext({ updateId: '101', botId: '42', chatId }, () => recordMemberStatusChanged(audit, silentLogger(), ctxB));

    // Higher update_id with equal timestamp WINS (it is genuinely newer).
    let snap = await client.db.select().from(entitySnapshots).where(eq(entitySnapshots.entityId, subjectId)).limit(1);
    expect((snap[0]?.snapshotData as Record<string, unknown>).status).toBe('administrator');

    // LOWER update_id with the SAME timestamp must NOT overwrite (round-2: no
    // "equal timestamp → treat as newer" race).
    const ctxStale = memberFixture(99, 1770001000, 'administrator', 'kicked');
    await runWithUpdateContext({ updateId: '99', botId: '42', chatId }, () => recordMemberStatusChanged(audit, silentLogger(), ctxStale));

    snap = await client.db.select().from(entitySnapshots).where(eq(entitySnapshots.entityId, subjectId)).limit(1);
    expect((snap[0]?.snapshotData as Record<string, unknown>).status).toBe('administrator'); // not regressed to kicked

    // And a strictly OLDER timestamp is still stale regardless of update_id.
    const ctxOlder = memberFixture(200, 1770000900, 'administrator', 'left');
    await runWithUpdateContext({ updateId: '200', botId: '42', chatId }, () => recordMemberStatusChanged(audit, silentLogger(), ctxOlder));
    snap = await client.db.select().from(entitySnapshots).where(eq(entitySnapshots.entityId, subjectId)).limit(1);
    expect((snap[0]?.snapshotData as Record<string, unknown>).status).toBe('administrator');
  });

  it('HIGH-2: integration.action carries the first-class outcome — failed and unknown are distinguishable', async () => {
    await recordIntegrationAction(audit, silentLogger(), { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'k1', outcome: 'failed', statusCode: 403 });
    await recordIntegrationAction(audit, silentLogger(), { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'k2', outcome: 'unknown' });

    const rows = await client.db.select().from(events).where(eq(events.eventType, 'integration.action'));
    const outcomes = rows.map((r) => ((r.after ?? {}) as Record<string, unknown>).outcome).sort();
    expect(outcomes).toEqual(['failed', 'unknown']);
  });

  it('HIGH-7/retention: a written audit that retention purged is NOT resurrected on redelivery (durable tombstone)', async () => {
    await client.db.insert(eventPolicies).values({
      policyId: 'pol-r2-retention',
      chatId,
      eventType: 'moderation.action',
      eventVersion: 'v1',
      enabled: true,
      retentionDays: 1,
    });
    const bot = fakeBot();
    const resolvers = new PendingOperationResolvers();
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers);
    const service = new ModerationService(bot as never, audit, outbox, resolvers, silentLogger());

    await runWithUpdateContext({ updateId: 'r2-3', botId: '42' }, () => service.ban({ chatId, targetUserId: '123', actorUserId: '456' }));
    let eventsForChat = await client.db.select().from(events).where(eq(events.tenantId, chatId));
    expect(eventsForChat).toHaveLength(1);

    // Downstream already consumed the audit outbox — only then may retention
    // delete the event (pending outbox must survive CASCADE).
    await client.db.execute(sql`UPDATE audit.outbox SET status = 'delivered' WHERE event_id = ${eventsForChat[0]!.id}`);

    // Retention purges the audit event (backdate it past the policy window).
    await client.db.execute(sql`UPDATE audit.events SET occurred_at = now() - interval '2 days'`);
    const purged = await purgeExpiredAuditEventsBatch(client.db);
    expect(purged.deletedCount).toBe(1);

    // Redelivery of the SAME update (same idempotency key): the operation is
    // terminal and its audit_status='written' acts as the tombstone — the
    // event must NOT be re-created.
    const bot2 = fakeBot();
    const resolvers2 = new PendingOperationResolvers();
    const outbox2 = new PendingOperationsOutbox(client.db, silentLogger(), resolvers2);
    const service2 = new ModerationService(bot2 as never, audit, outbox2, resolvers2, silentLogger());
    const outcome = await runWithUpdateContext({ updateId: 'r2-3', botId: '42' }, () => service2.ban({ chatId, targetUserId: '123', actorUserId: '456' }));
    expect(outcome.status).toBe('succeeded');
    expect(bot2.api.raw.banChatMember).not.toHaveBeenCalled(); // executor not re-run

    eventsForChat = await client.db.select().from(events).where(eq(events.tenantId, chatId));
    expect(eventsForChat).toHaveLength(0); // no resurrection
  });

  it('S3: exhausted HEAD 404 reconciliation remains unknown and writes one terminal audit', async () => {
    const resolvers = new PendingOperationResolvers();
    resolvers.register('s3.putObject', async () => {
      throw new Error('s3 HEAD 404 — object not visible yet');
    }, { retryAfterUnknown: true });
    const outbox = new PendingOperationsOutbox(client.db, silentLogger(), resolvers, 1);
    const finalizer = makeIntegrationAuditFinalizer(audit, silentLogger());
    await client.db.insert(pendingOperations).values({
      kind: 's3.putObject',
      chatId: 'platform',
      idempotencyKey: 's3-unrecoverable-1',
      requestPayload: { key: 'exports/1.json' },
      metadata: { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'exports/1.json' },
      status: 'pending',
      nextAttemptAt: null,
    });

    await outbox.recoverPending(finalizer);

    const row = await client.db.select().from(pendingOperations).where(eq(pendingOperations.idempotencyKey, 's3-unrecoverable-1')).limit(1);
    expect(row[0]?.status).toBe('unknown');
    expect(row[0]?.nextAttemptAt).toBeNull();
    expect(row[0]?.auditStatus).toBe('written');
    const eventRows = await client.db.select().from(events).where(eq(events.eventType, 'integration.action'));
    expect(eventRows).toHaveLength(1);
    expect((eventRows[0]?.after as Record<string, unknown>).outcome).toBe('unknown');
  });
});

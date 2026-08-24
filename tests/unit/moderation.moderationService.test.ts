import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';
import type { Logger } from '../../src/lib/logger.js';
import { buildDrizzleOrmMock, FakePendingOperationsDb, fakeLogger } from './testUtils/fakePendingOperationsDb.js';

vi.mock('drizzle-orm', async (importOriginal) => buildDrizzleOrmMock(await importOriginal<typeof import('drizzle-orm')>()));

const { pendingOperations } = await import('../../src/db/schema/moderation.js');
const { PendingOperationResolvers, PendingOperationsOutbox } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
const { ModerationService } = await import('../../src/lib/moderation/moderationService.js');
const { runWithUpdateContext } = await import('../../src/lib/context.js');
type AuditService = import('../../src/lib/auditService.js').AuditService;

function logger(): Logger {
  return fakeLogger() as unknown as Logger;
}

function fakeAuditService() {
  const calls: Array<{ input: Record<string, unknown>; result: unknown }> = [];
  const fakeTx = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
  };
  const audit = {
    recordEntityChange: vi.fn(async (input: Record<string, unknown>, mutate: (tx: unknown) => Promise<unknown>) => {
      const result = await mutate(fakeTx);
      calls.push({ input, result });
      return { eventId: 'evt', subjectSequence: 1, duplicate: false };
    }),
    maskOutboxMetadata: vi.fn(async (input: { metadata: Record<string, unknown> }) => input.metadata),
  } as unknown as AuditService;
  return { audit, calls };
}

function fakeBot() {
  return {
    botInfo: { id: 777 },
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

describe('ModerationService', () => {
  let db: FakePendingOperationsDb;
  let resolvers: InstanceType<typeof PendingOperationResolvers>;
  let outbox: InstanceType<typeof PendingOperationsOutbox>;

  beforeEach(() => {
    db = new FakePendingOperationsDb(pendingOperations);
    resolvers = new PendingOperationResolvers();
    outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
  });

  it('ban(): on success, calls Telegram once and writes exactly one moderation.action audit record with operation "create"', async () => {
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', botId: 'bot-42', chatId: '-100111' }, () => service.ban({ chatId: '-100111', targetUserId: '2', actorUserId: '9', reason: 'spam' }));

    expect(outcome).toEqual({ status: 'succeeded', willRetry: false, detail: {} });
    expect(bot.api.raw.banChatMember).toHaveBeenCalledTimes(1);
    expect(bot.api.raw.banChatMember).toHaveBeenCalledWith({ chat_id: -100111, user_id: 2 });
    expect(db.rows[0]?.idempotencyKey).toBe('moderation.action:telegram-update:bot-42:1:-100111:2:ban');
    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { eventType: string }; result: { after?: Record<string, unknown>; metadata?: Record<string, unknown> } };
    expect(call.input.eventType).toBe('moderation.action');
    expect(call.result.metadata).toMatchObject({ operation: 'create' });
    expect(call.result.after).toMatchObject({ action: 'ban', targetUserId: '2', reason: 'spam' });
  });

  it('ban(): a confirmed GrammyError (missing rights) yields status "failed" and audits operation "failed" — never retried', async () => {
    const bot = fakeBot();
    bot.api.raw.banChatMember.mockRejectedValueOnce(new GrammyError('Bad Request: not enough rights', { ok: false, error_code: 400, description: 'Bad Request: not enough rights' } as never, 'banChatMember', {}));
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () => service.ban({ chatId: '-100111', targetUserId: '2', actorUserId: '9' }));

    expect(outcome.status).toBe('failed');
    const call = calls[0] as { result: { metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toMatchObject({ operation: 'failed' });
  });

  it('ban(): an unconfirmed error yields "unknown" and — while retries remain — does not audit yet (one final record, not written early)', async () => {
    const bot = fakeBot();
    bot.api.raw.banChatMember.mockRejectedValueOnce(new Error('socket hang up'));
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () => service.ban({ chatId: '-100111', targetUserId: '2', actorUserId: '9' }));

    expect(outcome).toEqual({ status: 'unknown', willRetry: true });
    expect(calls).toHaveLength(0); // not yet — see pendingOperationsOutbox.ts's "ONE FINAL RECORD" note
  });

  it('kick(): a successful ban+unban pair writes exactly one moderation.action audit record (not one per Telegram call)', async () => {
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () => service.kick({ chatId: '-100111', targetUserId: '2', actorUserId: '9' }));

    expect(outcome.status).toBe('succeeded');
    expect(bot.api.raw.banChatMember).toHaveBeenCalledTimes(1);
    expect(bot.api.raw.unbanChatMember).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const call = calls[0] as { result: { after?: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ action: 'kick' });
  });

  it.each([
    ['the acting user', '9'],
    ['the bot itself', '777'],
  ])('kick(): rejects %s before WAL, Telegram, or audit work', async (_case, targetUserId) => {
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    await expect(
      runWithUpdateContext({ updateId: 'unsafe-kick', chatId: '-100111', botId: '777' }, () =>
        service.kick({ chatId: '-100111', targetUserId, actorUserId: '9' }),
      ),
    ).rejects.toThrow(/unsafe moderation target/i);

    expect(bot.api.raw.banChatMember).not.toHaveBeenCalled();
    expect(bot.api.raw.unbanChatMember).not.toHaveBeenCalled();
    expect(audit.maskOutboxMetadata).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });

  it('applies the same service-level self-target guard to non-kick moderation paths', async () => {
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    await expect(
      runWithUpdateContext({ updateId: 'unsafe-ban', chatId: '-100111', botId: '777' }, () =>
        service.ban({ chatId: '-100111', targetUserId: '9', actorUserId: '9' }),
      ),
    ).rejects.toThrow(/unsafe moderation target/i);

    expect(bot.api.raw.banChatMember).not.toHaveBeenCalled();
    expect(audit.maskOutboxMetadata).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });

  it('kick(): stops after a confirmed ban failure and never attempts the unban step', async () => {
    const bot = fakeBot();
    bot.api.raw.banChatMember.mockRejectedValueOnce(new GrammyError('Bad Request', { ok: false, error_code: 400, description: 'Bad Request' } as never, 'banChatMember', {}));
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () => service.kick({ chatId: '-100111', targetUserId: '2', actorUserId: '9' }));

    expect(outcome.status).toBe('failed');
    expect(bot.api.raw.unbanChatMember).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('BOTS-9 review HIGH-8: ban succeeds but unban confirms-fails — audited with partialOutcome "banned_not_kicked", not a generic indistinguishable failure', async () => {
    const bot = fakeBot();
    bot.api.raw.unbanChatMember.mockRejectedValueOnce(new GrammyError('Bad Request: not enough rights', { ok: false, error_code: 400, description: 'Bad Request: not enough rights' } as never, 'unbanChatMember', {}));
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () => service.kick({ chatId: '-100111', targetUserId: '2', actorUserId: '9' }));

    expect(outcome.status).toBe('failed');
    expect(bot.api.raw.banChatMember).toHaveBeenCalledTimes(1); // the ban half DID land
    expect(bot.api.raw.unbanChatMember).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const call = calls[0] as unknown as { result: { after?: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ partialOutcome: 'banned_not_kicked', action: 'kick' });
  });

  it('kick(): a row left in_progress by a crash between the ban and unban Telegram calls still completes both calls on recovery — the atomicity fix', async () => {
    // Simulates the exact gap the old two-outbox-row design had: the
    // process died mid-kick. With kick() now a single compound operation,
    // there is exactly one row, and recovery re-runs the *whole* executor
    // (both API calls), not just "resume from where it crashed" — which is
    // what makes replaying it safe (ban on an already-banned user is a
    // no-op; only the still-outstanding unban has a real effect).
    db.rows.push({
      id: 'row-kick-crashed',
      kind: 'telegram.kick',
      chatId: '-100111',
      requestPayload: { chat_id: -100111, user_id: 2 },
      metadata: { action: 'kick', actorUserId: '9', targetUserId: '2' },
      idempotencyKey: 'moderation.action:telegram-update:1:-100111:2:kick',
      status: 'in_progress', // crash happened after this row was claimed, before either Telegram call resolved
      attemptCount: 1,
      lastAttemptAt: new Date(),
      nextAttemptAt: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    await service.recoverPending();

    expect(bot.api.raw.banChatMember).toHaveBeenCalledTimes(1);
    expect(bot.api.raw.unbanChatMember).toHaveBeenCalledTimes(1); // the step that would have been silently lost under the old two-row design
    expect(db.rows[0]?.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    const call = calls[0] as unknown as { result: { after?: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ action: 'kick', targetUserId: '2' });
  });

  it('deleteMessage(): on success, records message.deleted (not moderation.action)', async () => {
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', botId: 'bot-42', chatId: '-100111' }, () => service.deleteMessage('-100111', '55', '9', '2'));

    expect(outcome.status).toBe('succeeded');
    expect(bot.api.raw.deleteMessage).toHaveBeenCalledWith({ chat_id: -100111, message_id: 55 });
    expect(db.rows[0]?.idempotencyKey).toBe('moderation.delete:telegram-update:bot-42:1:-100111:55');
    expect(calls).toHaveLength(1);
    const call = calls[0] as unknown as { input: { eventType: string } };
    expect(call.input.eventType).toBe('message.deleted');
  });

  it('recoverPending(): reconstructs and writes the moderation.action audit record for an operation that only resolved after a restart', async () => {
    // Simulate a row left `pending` when the process died right after write-ahead but before the Telegram call.
    db.rows.push({
      id: 'row-1',
      kind: 'telegram.banChatMember',
      chatId: '-100111',
      requestPayload: { chat_id: -100111, user_id: 2 },
      metadata: { action: 'ban', actorUserId: '9', targetUserId: '2', reason: 'spam' },
      idempotencyKey: 'moderation.action:telegram-update:1:-100111:2:ban',
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    // Constructing ModerationService with a *new process's* fresh resolvers/outbox — nothing on the call stack from the original command.
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    await service.recoverPending();

    expect(bot.api.raw.banChatMember).toHaveBeenCalledWith({ chat_id: -100111, user_id: 2 });
    expect(db.rows[0]?.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { idempotencyKey: string; actorId: string }; result: { after?: Record<string, unknown> } };
    expect(call.input.idempotencyKey).toBe('moderation.action:telegram-update:1:-100111:2:ban:audit');
    expect(call.input.actorId).toBe('9');
    expect(call.result.after).toMatchObject({ action: 'ban', targetUserId: '2', reason: 'spam' });
  });

  it('BOTS-9 round-2 BLOCKER-1: a recovered row missing audit metadata NEVER finalizes as written — the finalizer throws, audit_status stays pending, nothing is recorded', async () => {
    db.rows.push({
      id: 'row-2',
      kind: 'telegram.banChatMember',
      chatId: '-100111',
      requestPayload: { chat_id: -100111, user_id: 2 },
      metadata: {}, // nothing written ahead — must not silently finalize as 'written'
      idempotencyKey: 'k-broken',
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      result: null,
      auditStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const testLogger = logger();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, testLogger);

    await service.recoverPending();

    expect(calls).toHaveLength(0); // no audit event was fabricated
    expect(db.rows[0]?.auditStatus).toBe('pending'); // the audit is still owed — never 'written'
    expect(testLogger.error).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.moderation_action.recovered_without_metadata' }));
  });

  it('round-3: mute stores duration_seconds (not a frozen until_date) and recomputes until_date at call time', async () => {
    const bot = fakeBot();
    const { audit } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());
    const before = Math.floor(Date.now() / 1000);
    await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () =>
      service.restrict({ chatId: '-100111', targetUserId: '2', actorUserId: '9', durationSeconds: 600 }),
    );
    expect(db.rows[0]?.requestPayload).toMatchObject({ duration_seconds: 600 });
    expect(db.rows[0]?.requestPayload).toHaveProperty('until_date');
    const restrictCalls = bot.api.raw.restrictChatMember.mock.calls as unknown as ReadonlyArray<readonly [Record<string, unknown>]>;
    const called = restrictCalls[0]?.[0];
    expect(called).toBeDefined();
    expect(typeof called?.until_date).toBe('number');
    expect(called!.until_date as number).toBeGreaterThanOrEqual(before + 600);
    expect(called!.until_date as number).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600 + 2);
  });

  it('round-3: without update context, deleteMessage uses a stable key (no Date.now) so a retry cannot double-fire', async () => {
    const bot = fakeBot();
    const { audit } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());
    await service.deleteMessage('-100111', '55', '9');
    await service.deleteMessage('-100111', '55', '9');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.idempotencyKey).toBe('moderation.delete:-100111:55:9');
    expect(bot.api.raw.deleteMessage).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrammyError } from 'grammy';
import type { Logger } from '../../src/lib/logger.js';

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ kind: 'eq', col, val }),
    and: (...conds: unknown[]) => ({ kind: 'and', conds }),
    or: (...conds: unknown[]) => ({ kind: 'or', conds }),
    inArray: (col: unknown, vals: unknown[]) => ({ kind: 'inArray', col, vals }),
    lte: (col: unknown, val: unknown) => ({ kind: 'lte', col, val }),
    sql: (_strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: 'sqlIncrement', col: values[0] }),
  };
});

const { pendingOperations } = await import('../../src/db/schema/moderation.js');
const { PendingOperationResolvers, PendingOperationsOutbox } = await import('../../src/lib/moderation/pendingOperationsOutbox.js');
const { ModerationService } = await import('../../src/lib/moderation/moderationService.js');
const { runWithUpdateContext } = await import('../../src/lib/context.js');
type AuditService = import('../../src/lib/auditService.js').AuditService;

type Row = Record<string, unknown>;

const COLUMN_KEY = new Map<unknown, string>([
  [pendingOperations.id, 'id'],
  [pendingOperations.idempotencyKey, 'idempotencyKey'],
  [pendingOperations.status, 'status'],
  [pendingOperations.nextAttemptAt, 'nextAttemptAt'],
  [pendingOperations.attemptCount, 'attemptCount'],
]);

function keyFor(col: unknown): string {
  const key = COLUMN_KEY.get(col);
  if (!key) throw new Error('fake db: unmapped column in test condition');
  return key;
}

function evalCond(cond: any, row: Row): boolean {
  switch (cond.kind) {
    case 'eq':
      return row[keyFor(cond.col)] === cond.val;
    case 'lte': {
      const value = row[keyFor(cond.col)];
      return value !== null && value !== undefined && (value as Date) <= cond.val;
    }
    case 'inArray':
      return cond.vals.includes(row[keyFor(cond.col)]);
    case 'and':
      return cond.conds.every((c: unknown) => evalCond(c, row));
    case 'or':
      return cond.conds.some((c: unknown) => evalCond(c, row));
    default:
      throw new Error(`fake db: unknown condition kind ${String(cond.kind)}`);
  }
}

function deferredRows(getRows: () => Row[]) {
  return {
    then(onFulfilled: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
      return Promise.resolve(getRows()).then(onFulfilled, onRejected);
    },
    limit(n: number) {
      return deferredRows(() => getRows().slice(0, n));
    },
  };
}

function deferredMutation(apply: () => Row[]) {
  return {
    then(onFulfilled: (value: undefined) => unknown, onRejected?: (err: unknown) => unknown) {
      return Promise.resolve().then(apply).then(() => undefined).then(onFulfilled, onRejected);
    },
    returning() {
      return Promise.resolve(apply());
    },
  };
}

class FakePendingOperationsDb {
  public rows: Row[] = [];
  private nextId = 1;

  public select() {
    return { from: () => ({ where: (cond: unknown) => deferredRows(() => this.rows.filter((row) => evalCond(cond, row))) }) };
  }

  public insert() {
    return {
      values: (values: Row) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const idempotencyKey = values.idempotencyKey as string;
            if (this.rows.some((row) => row.idempotencyKey === idempotencyKey)) return Promise.resolve([]);
            const row: Row = {
              id: `row-${this.nextId++}`,
              kind: values.kind,
              chatId: values.chatId,
              requestPayload: values.requestPayload,
              metadata: values.metadata ?? {},
              idempotencyKey,
              status: values.status ?? 'pending',
              attemptCount: 0,
              lastAttemptAt: null,
              nextAttemptAt: null,
              result: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            this.rows.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
    };
  }

  public update() {
    return {
      set: (values: Row) => ({
        where: (cond: unknown) =>
          deferredMutation(() => {
            const matched = this.rows.filter((row) => evalCond(cond, row));
            for (const row of matched) {
              for (const [key, value] of Object.entries(values)) {
                if (value && typeof value === 'object' && (value as { kind?: string }).kind === 'sqlIncrement') {
                  row[key] = (row[keyFor((value as { col: unknown }).col)] as number) + 1;
                } else {
                  row[key] = value;
                }
              }
            }
            return matched;
          }),
      }),
    };
  }
}

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
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
  } as unknown as AuditService;
  return { audit, calls };
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

describe('ModerationService', () => {
  let db: FakePendingOperationsDb;
  let resolvers: InstanceType<typeof PendingOperationResolvers>;
  let outbox: InstanceType<typeof PendingOperationsOutbox>;

  beforeEach(() => {
    db = new FakePendingOperationsDb();
    resolvers = new PendingOperationResolvers();
    outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
  });

  it('ban(): on success, calls Telegram once and writes exactly one moderation.action audit record with operation "create"', async () => {
    const bot = fakeBot();
    const { audit, calls } = fakeAuditService();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, logger());

    const outcome = await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () => service.ban({ chatId: '-100111', targetUserId: '2', actorUserId: '9', reason: 'spam' }));

    expect(outcome).toEqual({ status: 'succeeded', willRetry: false, detail: {} });
    expect(bot.api.raw.banChatMember).toHaveBeenCalledTimes(1);
    expect(bot.api.raw.banChatMember).toHaveBeenCalledWith({ chat_id: -100111, user_id: 2 });
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

    const outcome = await runWithUpdateContext({ updateId: '1', chatId: '-100111' }, () => service.deleteMessage('-100111', '55', '9', '2'));

    expect(outcome.status).toBe('succeeded');
    expect(bot.api.raw.deleteMessage).toHaveBeenCalledWith({ chat_id: -100111, message_id: 55 });
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

  it('recoverPending(): logs a warning and skips auditing when a recovered row is missing the metadata needed to reconstruct the record', async () => {
    db.rows.push({
      id: 'row-2',
      kind: 'telegram.banChatMember',
      chatId: '-100111',
      requestPayload: { chat_id: -100111, user_id: 2 },
      metadata: {}, // nothing written ahead — should never happen via ModerationService itself, but must not crash recovery
      idempotencyKey: 'k-broken',
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
    const testLogger = logger();
    const service = new ModerationService(bot as never, audit, outbox, resolvers, testLogger);

    await service.recoverPending();

    expect(calls).toHaveLength(0);
    expect(testLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.moderation_action.recovered_without_metadata' }));
  });
});

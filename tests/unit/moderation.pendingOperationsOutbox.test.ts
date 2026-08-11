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

type Row = Record<string, unknown>;

const COLUMN_KEY = new Map<unknown, string>([
  [pendingOperations.id, 'id'],
  [pendingOperations.kind, 'kind'],
  [pendingOperations.chatId, 'chatId'],
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
  const self = {
    then(onFulfilled: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
      return Promise.resolve(getRows()).then(onFulfilled, onRejected);
    },
    limit(n: number) {
      return deferredRows(() => getRows().slice(0, n));
    },
  };
  return self;
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

/** Faithful-enough in-memory fake of the one table PendingOperationsOutbox touches, driven by the actual (mocked) drizzle-orm condition objects it builds — not just canned per-call responses. */
class FakePendingOperationsDb {
  public rows: Row[] = [];
  private nextId = 1;

  public select() {
    return {
      from: () => ({
        where: (cond: unknown) => deferredRows(() => this.rows.filter((row) => evalCond(cond, row))),
      }),
    };
  }

  public insert() {
    return {
      values: (values: Row) => ({
        onConflictDoNothing: (_opts: unknown) => ({
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

describe('PendingOperationsOutbox', () => {
  let db: FakePendingOperationsDb;
  let resolvers: InstanceType<typeof PendingOperationResolvers>;

  beforeEach(() => {
    db = new FakePendingOperationsDb();
    resolvers = new PendingOperationResolvers();
  });

  it('writes ahead, then a confirmed success is terminal and stores the result', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const executor = vi.fn(async () => ({ ok: true }));

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-1', requestPayload: { chat_id: 1, user_id: 2 } }, executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.isFinal).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.outcome).toEqual({ status: 'succeeded', result: { ok: true } });
    expect(db.rows[0]?.status).toBe('succeeded');
    // write-ahead really happened before the call resolved: exactly one row for this operation.
    expect(db.rows).toHaveLength(1);
  });

  it('a confirmed GrammyError is terminal and status "failed" — never retried', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    const error = new GrammyError('Bad Request: not enough rights', { ok: false, error_code: 400, description: 'Bad Request: not enough rights' } as never, 'banChatMember', {});
    const executor = vi.fn(async () => {
      throw error;
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-2', requestPayload: {} }, executor);

    expect(result.isFinal).toBe(true);
    expect(result.outcome.status).toBe('failed');
    expect(db.rows[0]?.status).toBe('failed');
    expect(db.rows[0]?.attemptCount).toBe(1);

    // Calling again with the same idempotencyKey must not re-invoke the executor.
    const second = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-2', requestPayload: {} }, executor);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(second.duplicate).toBe(true);
    expect(second.outcome.status).toBe('failed');
  });

  it('an unconfirmed error (timeout/network) is "unknown", not "failed", and is not final while retries remain', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 5, 10);
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-3', requestPayload: {} }, executor);

    expect(result.outcome.status).toBe('unknown');
    expect(result.isFinal).toBe(false); // retries remain — must not be audited yet
    expect(db.rows[0]?.status).toBe('unknown');
    expect(db.rows[0]?.nextAttemptAt).not.toBeNull();
  });

  it('a genuine timeout (executor never resolves) also becomes "unknown", never "failed"', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 5, 20);
    const executor = vi.fn(() => new Promise<void>(() => undefined)); // never resolves

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-timeout', requestPayload: {} }, executor);

    expect(result.outcome.status).toBe('unknown');
    expect(db.rows[0]?.status).toBe('unknown');
  });

  it('"unknown" becomes final (isFinal=true) once retries are exhausted', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers, 1, 10); // maxAttempts=1
    const executor = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    const result = await outbox.execute({ kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-4', requestPayload: {} }, executor);

    expect(result.outcome.status).toBe('unknown');
    expect(result.isFinal).toBe(true); // exhausted — this is the one moment it should be audited as unknown
    expect(db.rows[0]?.status).toBe('unknown');
  });

  it('recoverPending() resumes an interrupted row (in_progress after a crash) and calls onFinal once it resolves', async () => {
    db.rows.push({
      id: 'row-crashed',
      kind: 'telegram.banChatMember',
      chatId: 'chat-1',
      requestPayload: { chat_id: 1, user_id: 2 },
      metadata: { action: 'ban', actorUserId: '9', targetUserId: '2' },
      idempotencyKey: 'key-crashed',
      status: 'in_progress',
      attemptCount: 1,
      lastAttemptAt: new Date(),
      nextAttemptAt: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    resolvers.register('telegram.banChatMember', async () => ({ ok: true }));

    const onFinal = vi.fn();
    await outbox.recoverPending(onFinal);

    expect(db.rows[0]?.status).toBe('succeeded');
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onFinal.mock.calls[0]?.[0]?.id).toBe('row-crashed');
    expect(onFinal.mock.calls[0]?.[1]).toEqual({ status: 'succeeded', result: { ok: true } });
  });

  it('recoverPending() leaves a row alone (and never calls its executor) when no resolver is registered for its kind', async () => {
    db.rows.push({
      id: 'row-orphan',
      kind: 'telegram.someFutureCall',
      chatId: 'chat-1',
      requestPayload: {},
      metadata: {},
      idempotencyKey: 'key-orphan',
      status: 'pending',
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      result: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);

    const onFinal = vi.fn();
    await outbox.recoverPending(onFinal);

    expect(db.rows[0]?.status).toBe('pending'); // untouched
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('two concurrent calls for the same idempotencyKey never both invoke the executor', async () => {
    const outbox = new PendingOperationsOutbox(db as never, logger(), resolvers);
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    const executor = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) await gate;
      return { ok: true };
    });

    const input = { kind: 'telegram.banChatMember', chatId: 'chat-1', idempotencyKey: 'key-race', requestPayload: {} };
    const first = outbox.execute(input, executor);
    // Let the first call's write-ahead + claim land before starting the second.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = outbox.execute(input, executor);
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect([firstResult.isFinal, secondResult.isFinal].filter(Boolean)).toHaveLength(1);
  });
});

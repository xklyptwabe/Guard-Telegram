import { vi } from 'vitest';

export type Row = Record<string, unknown>;

/**
 * The condition objects `eq`/`and`/`or`/`inArray`/`lte`/`lt`/`isNull` build when
 * mocked — a tiny AST `evalCond` below can interpret directly against an
 * in-memory row, instead of needing a real SQL engine. `sql` keeps enough
 * of its template (fragments + interpolated args) for evalCond to interpret
 * the two shapes the codebase builds with it: `col + 1` (increment on
 * UPDATE) and `col < $n` (bound check in WHERE).
 */
export function buildDrizzleOrmMock(actual: Record<string, unknown>) {
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ kind: 'eq', col, val }),
    ne: (col: unknown, val: unknown) => ({ kind: 'ne', col, val }),
    and: (...conds: unknown[]) => ({ kind: 'and', conds }),
    or: (...conds: unknown[]) => ({ kind: 'or', conds }),
    inArray: (col: unknown, vals: unknown[]) => ({ kind: 'inArray', col, vals }),
    lte: (col: unknown, val: unknown) => ({ kind: 'lte', col, val }),
    gt: (col: unknown, val: unknown) => ({ kind: 'gt', col, val }),
    lt: (col: unknown, val: unknown) => ({ kind: 'lt', col, val }),
    isNull: (col: unknown) => ({ kind: 'isNull', col }),
    isNotNull: (col: unknown) => ({ kind: 'isNotNull', col }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ kind: 'sqlExpr', col: values[0], template: strings.join('\u0000'), args: values.slice(1) }),
  };
}

export function makeColumnKey(pendingOperations: object): Map<unknown, string> {
  const table = pendingOperations as Record<string, unknown>;
  return new Map<unknown, string>([
    [table.id, 'id'],
    [table.ownerId, 'ownerId'],
    [table.kind, 'kind'],
    [table.chatId, 'chatId'],
    [table.idempotencyKey, 'idempotencyKey'],
    [table.operationFingerprint, 'operationFingerprint'],
    [table.supersessionKey, 'supersessionKey'],
    [table.status, 'status'],
    [table.nextAttemptAt, 'nextAttemptAt'],
    [table.attemptCount, 'attemptCount'],
    [table.workerId, 'workerId'],
    [table.leaseExpiresAt, 'leaseExpiresAt'],
    [table.auditStatus, 'auditStatus'],
    [table.auditWorkerId, 'auditWorkerId'],
    [table.auditLeaseExpiresAt, 'auditLeaseExpiresAt'],
    [table.createdAt, 'createdAt'],
  ]);
}

function keyFor(columnKey: Map<unknown, string>, col: unknown): string {
  const key = columnKey.get(col);
  if (!key) throw new Error('fake db: unmapped column in test condition');
  return key;
}

export function evalCond(columnKey: Map<unknown, string>, cond: any, row: Row, rows: Row[] = []): boolean {
  switch (cond.kind) {
    case 'eq': {
      const key = keyFor(columnKey, cond.col);
      const value = key === 'ownerId' ? (row[key] ?? 'legacy') : row[key];
      return value === cond.val;
    }
    case 'ne': {
      const key = keyFor(columnKey, cond.col);
      const value = key === 'ownerId' ? (row[key] ?? 'legacy') : row[key];
      return value !== cond.val;
    }
    case 'lte': {
      const value = row[keyFor(columnKey, cond.col)];
      return value !== null && value !== undefined && (value as Date) <= cond.val;
    }
    case 'gt': {
      const value = row[keyFor(columnKey, cond.col)];
      return value !== null && value !== undefined && (value as Date) > cond.val;
    }
    case 'lt': {
      const value = row[keyFor(columnKey, cond.col)];
      return value !== null && value !== undefined && (value as Date) < cond.val;
    }
    case 'isNull':
      return row[keyFor(columnKey, cond.col)] === null || row[keyFor(columnKey, cond.col)] === undefined;
    case 'isNotNull': {
      const value = row[keyFor(columnKey, cond.col)];
      return value !== null && value !== undefined;
    }
    case 'inArray':
      return cond.vals.includes(row[keyFor(columnKey, cond.col)]);
    case 'and':
      return cond.conds.every((c: unknown) => evalCond(columnKey, c, row, rows));
    case 'or':
      return cond.conds.some((c: unknown) => evalCond(columnKey, c, row, rows));
    case 'sqlExpr': {
      const value = row[keyFor(columnKey, cond.col)];
      if (cond.template.includes('SELECT candidate."created_at"')) {
        const source = rows.find((candidate) => candidate.id === cond.args[0]);
        return source !== undefined && (value as Date) > (source.createdAt as Date);
      }
      if (cond.template.includes('<')) return value !== null && value !== undefined && (value as number) < cond.args[0];
      if (cond.template.includes('>=')) return value !== null && value !== undefined && (value as number) >= cond.args[0];
      throw new Error(`fake db: unsupported sql template "${cond.template}"`);
    }
    default:
      throw new Error(`fake db: unknown condition kind ${String(cond.kind)}`);
  }
}

function deferredRows(getRows: () => Row[]) {
  const self = {
    then(onFulfilled: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
      return Promise.resolve(getRows()).then(onFulfilled, onRejected);
    },
    orderBy() {
      return self;
    },
    limit(n: number) {
      return deferredRows(() => getRows().slice(0, n));
    },
    for() {
      // FOR UPDATE [SKIP LOCKED] — no-op here: this fake is single-threaded
      // and processes one call at a time, so real row-locking semantics
      // never come into play. What matters for these tests is that the
      // *condition* evaluation (which rows are "due") is correct, which
      // `evalCond` above already handles identically to the real claim
      // query.
      return self;
    },
  };
  return self;
}

function deferredMutation(apply: () => Row[]) {
  return {
    then(onFulfilled: (value: undefined) => unknown, onRejected?: (err: unknown) => unknown) {
      return Promise.resolve()
        .then(apply)
        .then(() => undefined)
        .then(onFulfilled, onRejected);
    },
    returning(shape?: Record<string, unknown>) {
      return Promise.resolve(apply()).then((rows) => (shape ? rows.map((row) => ({ id: row.id })) : rows));
    },
  };
}

/** Faithful-enough in-memory fake of the one table PendingOperationsOutbox touches, driven by the actual (mocked) drizzle-orm condition objects it builds. `.transaction(cb)` just invokes `cb(this)` — there is no real concurrency inside a single fake instance during one microtask chain, so no separate isolation is needed to exercise the claim-then-update logic correctly. */
export class FakePendingOperationsDb {
  public rows: Row[] = [];
  private nextId = 1;
  private readonly columnKey: Map<unknown, string>;

  public constructor(pendingOperationsTable: object) {
    this.columnKey = makeColumnKey(pendingOperationsTable);
  }

  public select(shape?: Record<string, unknown>) {
    return {
      from: () => ({
        where: (cond: unknown) => {
          const filtered = () => this.rows.filter((row) => evalCond(this.columnKey, cond, row, this.rows));
          const projected = shape ? () => filtered().map((row) => this.project(row, shape)) : filtered;
          return deferredRows(projected);
        },
      }),
    };
  }

  private project(row: Row, shape: Record<string, unknown>): Row {
    const result: Row = {};
    for (const key of Object.keys(shape)) result[key] = row[key];
    return result;
  }

  public insert() {
    return {
      values: (values: Row) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const idempotencyKey = values.idempotencyKey as string;
            const ownerId = (values.ownerId as string | undefined) ?? 'legacy';
            if (this.rows.some((row) => row.ownerId === ownerId && row.idempotencyKey === idempotencyKey)) return Promise.resolve([]);
            const row: Row = {
              id: `row-${this.nextId++}`,
              ownerId,
              kind: values.kind,
              chatId: values.chatId,
              requestPayload: values.requestPayload,
              metadata: values.metadata ?? {},
              idempotencyKey,
              operationFingerprint: values.operationFingerprint ?? null,
              supersessionKey: values.supersessionKey ?? null,
              status: values.status ?? 'pending',
              attemptCount: 0,
              lastAttemptAt: null,
              nextAttemptAt: null,
              workerId: null,
              leaseExpiresAt: null,
              auditStatus: 'pending',
              auditWorkerId: null,
              auditLeaseExpiresAt: null,
              result: null,
              createdAt: new Date(this.nextId), // monotonically increasing, stands in for insertion order
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
            const matched = this.rows.filter((row) => evalCond(this.columnKey, cond, row, this.rows));
            for (const row of matched) {
              for (const [key, value] of Object.entries(values)) {
                if (value && typeof value === 'object' && (value as { kind?: string }).kind === 'sqlExpr') {
                  const expr = value as { col: unknown; template: string };
                  if (expr.template.includes('+ 1')) {
                    row[keyFor(this.columnKey, expr.col)] = (row[keyFor(this.columnKey, expr.col)] as number) + 1;
                  } else {
                    throw new Error(`fake db: unsupported sql set template "${expr.template}"`);
                  }
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

  public async transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

export function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

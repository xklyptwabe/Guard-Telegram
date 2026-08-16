import { evalCond, type Row } from './fakePendingOperationsDb.js';

export type { Row };

/**
 * Generic single-table in-memory fake driven by the mocked drizzle-orm
 * condition objects (see buildDrizzleOrmMock in fakePendingOperationsDb.ts).
 * Exists so a second table fake — e.g. the update inbox's
 * `core.processed_updates` — reuses the exact same condition-interpretation
 * machinery instead of a diverging copy. A diverging copy is exactly how
 * the moderation fake fell out of sync with production code once already
 * (the BLOCKER-2 test port).
 *
 * `columnKey` maps table column objects → row property names;
 * `conflictKey` picks the row property whose uniqueness stands in for the
 * table's ON CONFLICT target.
 */
export class FakeDrizzleTableDb {
  public rows: Row[] = [];

  public constructor(
    protected readonly columnKey: Map<unknown, string>,
    /** Row properties forming the ON CONFLICT target (composite keys supported). */
    private readonly conflictKeys: readonly string[],
    private readonly defaults: Row = {},
  ) {}

  protected keyFor(col: unknown): string {
    const key = this.columnKey.get(col);
    if (!key) throw new Error('fake db: unmapped column in test condition');
    return key;
  }

  private conflictsWith(values: Row, row: Row): boolean {
    return this.conflictKeys.every((key) => row[key] === values[key]);
  }

  protected eval(cond: unknown, row: Row): boolean {
    return evalCond(this.columnKey, cond, row);
  }

  public select(shape?: Record<string, unknown>) {
    return {
      from: () => ({
        where: (cond: unknown) => {
          const filtered = () => this.rows.filter((row) => this.eval(cond, row));
          const projected = shape ? () => filtered().map((row) => FakeDrizzleTableDb.project(row, shape!)) : filtered;
          const self = {
            then(onFulfilled: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
              return Promise.resolve(projected()).then(onFulfilled, onRejected);
            },
            orderBy() {
              return self;
            },
            limit(n: number) {
              const limited = () => projected().slice(0, n);
              return {
                then(onFulfilled: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
                  return Promise.resolve(limited()).then(onFulfilled, onRejected);
                },
                // FOR UPDATE [SKIP LOCKED] — no-op in a single-threaded fake;
                // the claim's *condition* evaluation is what these tests verify.
                for() {
                  return self;
                },
              };
            },
            for() {
              return self;
            },
          };
          return self;
        },
      }),
    };
  }

  public insert() {
    const apply = (values: Row, onConflict: 'nothing' | 'update'): Row[] => {
      const existing = this.rows.find((row) => this.conflictsWith(values, row));
      if (existing) return onConflict === 'nothing' ? [] : [existing];
      const row: Row = { ...this.defaults, ...values };
      this.rows.push(row);
      return [row];
    };
    return {
      values: (values: Row) => ({
        onConflictDoNothing: () => ({
          returning: (shape?: Record<string, unknown>) => Promise.resolve(apply(values, 'nothing')).then((rows) => (shape ? rows.map((row) => FakeDrizzleTableDb.project(row, shape!)) : rows)),
          then(onFulfilled: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
            return Promise.resolve(apply(values, 'nothing')).then(onFulfilled, onRejected);
          },
        }),
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve(apply(values, 'update')),
          then(onFulfilled: (rows: Row[]) => unknown, onRejected?: (err: unknown) => unknown) {
            return Promise.resolve(apply(values, 'update')).then(onFulfilled, onRejected);
          },
        }),
      }),
    };
  }

  public update() {
    return {
      set: (values: Row) => ({
        where: (cond: unknown) => {
          const apply = () => {
            const matched = this.rows.filter((row) => this.eval(cond, row));
            for (const row of matched) {
              for (const [key, value] of Object.entries(values)) {
                if (value && typeof value === 'object' && (value as { kind?: string }).kind === 'sqlExpr') {
                  const expr = value as { col: unknown; template: string };
                  if (expr.template.includes('+ 1')) {
                    row[this.keyFor(expr.col)] = (row[this.keyFor(expr.col)] as number) + 1;
                  } else {
                    throw new Error(`fake db: unsupported sql set template "${expr.template}"`);
                  }
                } else {
                  row[key] = value;
                }
              }
            }
            return matched;
          };
          return {
            then(onFulfilled: (value: undefined) => unknown, onRejected?: (err: unknown) => unknown) {
              return Promise.resolve()
                .then(apply)
                .then(() => undefined)
                .then(onFulfilled, onRejected);
            },
            returning(shape?: Record<string, unknown>) {
              return Promise.resolve(apply()).then((rows) => (shape ? rows.map((row) => FakeDrizzleTableDb.project(row, shape!)) : rows));
            },
          };
        },
      }),
    };
  }

  public async transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  private static project(row: Row, shape: Record<string, unknown>): Row {
    const result: Row = {};
    for (const key of Object.keys(shape)) result[key] = row[key];
    return result;
  }
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import * as schema from './schema/core.js';

export type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseClient {
  readonly pool: Pool;
  readonly db: DrizzleDatabase;
  close(): Promise<void>;
}

export function createDatabase(config: Pick<AppConfig, 'databaseUrl' | 'databaseTlsRejectUnauthorized' | 'databaseTlsCa' | 'databaseTlsCert' | 'databaseTlsKey'>): DatabaseClient {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
      rejectUnauthorized: config.databaseTlsRejectUnauthorized,
      ...(config.databaseTlsCa ? { ca: config.databaseTlsCa } : {}),
      ...(config.databaseTlsCert ? { cert: config.databaseTlsCert } : {}),
      ...(config.databaseTlsKey ? { key: config.databaseTlsKey } : {}),
    },
  });
  return {
    pool,
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

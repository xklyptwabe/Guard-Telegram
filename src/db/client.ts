import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import * as coreSchema from './schema/core.js';
import * as auditSchema from './schema/audit.js';

const schema = { ...coreSchema, ...auditSchema };

export type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseClient {
  readonly pool: Pool;
  readonly db: DrizzleDatabase;
  close(): Promise<void>;
}

export function createDatabase(config: Pick<AppConfig, 'databaseUrl' | 'databaseTlsRejectUnauthorized' | 'databaseTlsCa' | 'databaseTlsCert' | 'databaseTlsKey'>): DatabaseClient {
  return createDatabaseClient({
    databaseUrl: config.databaseUrl,
    databaseTlsRejectUnauthorized: config.databaseTlsRejectUnauthorized,
    databaseTlsCa: config.databaseTlsCa,
    databaseTlsCert: config.databaseTlsCert,
    databaseTlsKey: config.databaseTlsKey,
  });
}

export function createAuditRetentionDatabase(
  config: Pick<AppConfig, 'auditRetentionDatabaseUrl' | 'databaseTlsRejectUnauthorized' | 'databaseTlsCa' | 'databaseTlsCert' | 'databaseTlsKey'>,
): DatabaseClient {
  if (config.auditRetentionDatabaseUrl === undefined) {
    throw new Error('AUDIT_RETENTION_DATABASE_URL is required for the audit retention job.');
  }
  return createDatabaseClient({
    databaseUrl: config.auditRetentionDatabaseUrl,
    databaseTlsRejectUnauthorized: config.databaseTlsRejectUnauthorized,
    databaseTlsCa: config.databaseTlsCa,
    databaseTlsCert: config.databaseTlsCert,
    databaseTlsKey: config.databaseTlsKey,
  });
}

function createDatabaseClient(config: Pick<AppConfig, 'databaseUrl' | 'databaseTlsRejectUnauthorized' | 'databaseTlsCa' | 'databaseTlsCert' | 'databaseTlsKey'>): DatabaseClient {
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

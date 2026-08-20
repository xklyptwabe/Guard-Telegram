import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { AppConfig } from '../config.js';
import type { Logger } from '../lib/logger.js';
import * as coreSchema from './schema/core.js';
import * as auditSchema from './schema/audit.js';
import * as moderationSchema from './schema/moderation.js';

const schema = { ...coreSchema, ...auditSchema, ...moderationSchema };

export type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseClient {
  readonly pool: Pool;
  readonly db: DrizzleDatabase;
  close(): Promise<void>;
}

export function createDatabase(config: Pick<AppConfig, 'databaseUrl' | 'databaseTlsRejectUnauthorized' | 'databaseTlsCa' | 'databaseTlsCert' | 'databaseTlsKey'>, logger?: Logger): DatabaseClient {
  return createDatabaseClient(
    {
      databaseUrl: config.databaseUrl,
      databaseTlsRejectUnauthorized: config.databaseTlsRejectUnauthorized,
      databaseTlsCa: config.databaseTlsCa,
      databaseTlsCert: config.databaseTlsCert,
      databaseTlsKey: config.databaseTlsKey,
    },
    logger,
  );
}

export function createAuditRetentionDatabase(
  config: Pick<AppConfig, 'auditRetentionDatabaseUrl' | 'databaseTlsRejectUnauthorized' | 'databaseTlsCa' | 'databaseTlsCert' | 'databaseTlsKey'>,
  logger?: Logger,
): DatabaseClient {
  if (config.auditRetentionDatabaseUrl === undefined) {
    throw new Error('AUDIT_RETENTION_DATABASE_URL is required for the audit retention job.');
  }
  return createDatabaseClient(
    {
      databaseUrl: config.auditRetentionDatabaseUrl,
      databaseTlsRejectUnauthorized: config.databaseTlsRejectUnauthorized,
      databaseTlsCa: config.databaseTlsCa,
      databaseTlsCert: config.databaseTlsCert,
      databaseTlsKey: config.databaseTlsKey,
    },
    logger,
  );
}

function createDatabaseClient(
  config: Pick<AppConfig, 'databaseUrl' | 'databaseTlsRejectUnauthorized' | 'databaseTlsCa' | 'databaseTlsCert' | 'databaseTlsKey'>,
  logger?: Logger,
): DatabaseClient {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
      rejectUnauthorized: config.databaseTlsRejectUnauthorized,
      ...(config.databaseTlsCa ? { ca: config.databaseTlsCa } : {}),
      ...(config.databaseTlsCert ? { cert: config.databaseTlsCert } : {}),
      ...(config.databaseTlsKey ? { key: config.databaseTlsKey } : {}),
    },
  });
  // BOT-13: `pg.Pool` documents that an idle client's connection error
  // (server restart, network drop, admin-killed connection — anything that
  // severs a connection nobody is actively querying through) is emitted as
  // the pool's own 'error' event. Node's EventEmitter throws an unhandled
  // 'error' event by default, which crashes the entire process — not just
  // fails the in-flight operation. Without this handler, a *temporary*
  // Postgres outage took down the whole bot instead of the individual
  // queries in flight failing cleanly (which they already do correctly via
  // the connection promise rejecting). Found via BOT-13's Postgres-outage
  // scenario against a real instance.
  pool.on('error', (error: Error) => {
    logger?.error({ event: 'database.pool.idle_client_error', error: { name: error.name, message: error.message } });
  });
  // A live checkout also emits 'error' when postmaster dies (57P01). Unhandled
  // that becomes an uncaughtException — vitest exit 1 / process crash — even
  // after the query promise already rejected.
  pool.on('connect', (client) => {
    client.on('error', (error: Error) => {
      logger?.error({ event: 'database.client.connection_error', error: { name: error.name, message: error.message } });
    });
  });
  return {
    pool,
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

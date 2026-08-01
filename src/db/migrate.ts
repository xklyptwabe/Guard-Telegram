import 'dotenv/config';

import path from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { validateConfig } from '../config.js';
import { Logger } from '../lib/logger.js';
import { createDatabase } from './client.js';

export async function runMigrations(config = validateConfig()): Promise<void> {
  const logger = new Logger(config);
  const database = createDatabase(config);
  try {
    await migrate(database.db, { migrationsFolder: 'src/db/migrations' });
    logger.info({ event: 'database.migrations.completed' });
  } finally {
    await database.close();
  }
}

if (process.argv[1] != null && /^migrate\.(ts|js)$/.test(path.basename(process.argv[1]))) {
  void runMigrations().catch((error: unknown) => {
    const logger = new Logger({ nodeEnv: 'development', logLevel: 'error' });
    logger.error({ event: 'database.migrations.failed', error: { name: 'MigrationError', message: error instanceof Error ? error.message : String(error) } });
    process.exitCode = 1;
  });
}

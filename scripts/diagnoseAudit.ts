import 'dotenv/config';

import { validateConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { readAuditOperationalState } from '../src/lib/audit/operationalState.js';
import { Logger, normalizeError } from '../src/lib/logger.js';

async function main(): Promise<void> {
  const config = validateConfig();
  const logger = new Logger(config);
  const database = createDatabase(config, logger);
  try {
    const state = await readAuditOperationalState(database.db);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const fallbackLogger = new Logger({ nodeEnv: 'production', logLevel: 'error' });
  fallbackLogger.error({ event: 'audit.diagnostics.failed', error: normalizeError(error) });
  process.exitCode = 1;
});

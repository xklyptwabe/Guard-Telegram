import 'dotenv/config';

import { validateConfig } from '../src/config.js';
import { createAuditRetentionDatabase } from '../src/db/client.js';
import { purgeExpiredAuditEventsBatch } from '../src/db/retention.js';

async function main(): Promise<void> {
  const config = validateConfig();
  const database = createAuditRetentionDatabase(config);
  try {
    const result = await purgeExpiredAuditEventsBatch(database.db);
    process.stdout.write(`audit retention deleted ${result.deletedCount} event(s).\n`);
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Audit retention job failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

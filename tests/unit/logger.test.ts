import { describe, expect, it, vi } from 'vitest';

import { Logger, redact } from '../../src/lib/logger.js';
import { runWithUpdateContext } from '../../src/lib/context.js';

describe('logging redaction', () => {
  it('removes secret-bearing fields and URL credentials', () => {
    expect(redact({ botToken: 'secret', databaseUrl: 'postgres://user:password@host/db', nested: { authorization: 'Bearer value' } })).toEqual({
      botToken: '[REDACTED]',
      databaseUrl: '[REDACTED]',
      nested: { authorization: '[REDACTED]' },
    });
  });

  it('emits one JSON object per line', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new Logger({ nodeEnv: 'test', logLevel: 'info' }).info({ event: 'test.event', details: { value: 1 } });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/"event":"test.event".*\n$/));
    write.mockRestore();
  });

  it('adds the current update correlation context automatically', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runWithUpdateContext({ updateId: '42', chatId: '-1001', userId: '7' }, async () => {
      new Logger({ nodeEnv: 'test', logLevel: 'info' }).info({ event: 'test.context' });
    });
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/"correlationId":"[0-9a-f-]{36}".*"updateId":"42"/));
    write.mockRestore();
  });
});

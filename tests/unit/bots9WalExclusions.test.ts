import { describe, expect, it } from 'vitest';

import { BOTS9_WAL_EXCLUSIONS, bots9WalExclusion } from '../../src/lib/bots9WalExclusions.js';

describe('BOTS-9 WAL exclusions', () => {
  it('lists only the accepted bootstrap/UX/protocol mutations', () => {
    expect([...BOTS9_WAL_EXCLUSIONS].sort()).toEqual(
      [
        'rabbitmq.ack',
        'rabbitmq.nack',
        'telegram.answerCallbackQuery',
        'telegram.sendMessage',
        'telegram.setMyCommands',
        'telegram.setWebhook',
      ].sort(),
    );
    expect(bots9WalExclusion('telegram.sendMessage')).toBe('telegram.sendMessage');
  });
});

import { describe, expect, it } from 'vitest';

import { BOTS9_WAL_EXCLUSIONS, bots9WalExclusion } from '../../src/lib/bots9WalExclusions.js';

describe('BOTS-9 WAL exclusions', () => {
  it('lists only the accepted bootstrap/UX/protocol mutations', () => {
    expect([...BOTS9_WAL_EXCLUSIONS].sort()).toEqual(['rabbitmq.ack', 'rabbitmq.nack'].sort());
    expect(bots9WalExclusion('rabbitmq.ack')).toBe('rabbitmq.ack');
  });
});

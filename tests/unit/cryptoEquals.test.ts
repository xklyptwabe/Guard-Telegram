import { describe, expect, it } from 'vitest';

import { constantTimeEquals } from '../../src/lib/cryptoEquals.js';

describe('constantTimeEquals', () => {
  it('accepts equal secrets of any length', () => {
    expect(constantTimeEquals('short', 'short')).toBe(true);
    expect(constantTimeEquals('a-quite-long-webhook-secret', 'a-quite-long-webhook-secret')).toBe(true);
  });

  it('rejects different values even when lengths differ', () => {
    expect(constantTimeEquals('abc', 'ab')).toBe(false);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });
});

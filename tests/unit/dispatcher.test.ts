import { describe, expect, it } from 'vitest';

import { decodeCallback, encodeCallback } from '../../src/core/dispatcher.js';

describe('callback envelope', () => {
  it('round-trips compact, versioned callback data', () => {
    const data = encodeCallback('echo', 'hello');
    expect(data).toMatch(/^v1:echo:/);
    expect(decodeCallback(data)).toEqual({ commandName: 'echo', rawArguments: 'hello' });
  });

  it('rejects a malformed or oversized callback', () => {
    expect(decodeCallback('v0:echo:')).toBeUndefined();
    expect(() => encodeCallback('echo', 'x'.repeat(128))).toThrow(/64-byte/);
  });
});

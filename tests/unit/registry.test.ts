import { describe, expect, it } from 'vitest';

import { resolveModuleEnabled } from '../../src/core/registry.js';

describe('sparse module state', () => {
  it('uses a module default while no chat override exists', () => {
    expect(resolveModuleEnabled(true, undefined)).toBe(true);
    expect(resolveModuleEnabled(false, undefined)).toBe(false);
  });

  it('uses an explicit chat override without affecting other chats', () => {
    expect(resolveModuleEnabled(true, false)).toBe(false);
    expect(resolveModuleEnabled(false, true)).toBe(true);
  });
});

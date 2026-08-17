import { describe, expect, it } from 'vitest';

import { Cooldowns } from '../../src/lib/cooldowns.js';

describe('Cooldowns', () => {
  it('allows the first call and rejects calls inside the window', () => {
    const cooldowns = new Cooldowns();
    expect(cooldowns.take('chat:user:command', 1_000, 10_000)).toBe(true);
    expect(cooldowns.take('chat:user:command', 1_000, 10_500)).toBe(false);
  });

  it('allows again once the window has expired', () => {
    const cooldowns = new Cooldowns();
    expect(cooldowns.take('key', 1_000, 10_000)).toBe(true);
    expect(cooldowns.take('key', 1_000, 11_000)).toBe(true); // ровно на границе
  });

  it('tracks keys independently', () => {
    const cooldowns = new Cooldowns();
    expect(cooldowns.take('a', 1_000, 10_000)).toBe(true);
    expect(cooldowns.take('b', 1_000, 10_000)).toBe(true);
    expect(cooldowns.take('a', 1_000, 10_100)).toBe(false);
  });

  it('sweeps expired entries once the map outgrows the threshold (bounded memory)', () => {
    const cooldowns = new Cooldowns();
    const internals = cooldowns as unknown as { expiresAt: Map<string, number> };
    // Заполняем карту мгновенно истекающими ключами при замороженном времени:
    // ничего не выметается, пока записи формально живы.
    for (let i = 0; i < 1_500; i += 1) {
      cooldowns.take(`stale:${i}`, 1, 0);
    }
    expect(internals.expiresAt.size).toBe(1_500);

    // Первое же обращение после того, как всё истекло, выметает карту скопом.
    expect(cooldowns.take('fresh', 1_000, 100)).toBe(true);
    expect(internals.expiresAt.size).toBe(1); // без чистки было бы 1501
    expect(internals.expiresAt.has('stale:0')).toBe(false);
    expect(internals.expiresAt.has('fresh')).toBe(true);
    expect(cooldowns.take('fresh', 1_000, 150)).toBe(false); // живой ключ не пострадал
  });
});

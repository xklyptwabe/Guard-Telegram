import type { RedisClient } from '../db/redis.js';

/**
 * BOTS-9 review finding (HIGH-5) — documented exclusion: the Redis SET here
 * is a cache-aside fill, not a state mutation — the source of truth is the
 * `read()` fallback (PostgreSQL) and any missed fill self-heals on the next
 * read. Write-ahead/outbox machinery would add a DB write to avoid… a DB
 * read. Failures are swallowed by design (`.catch(() => undefined)`).
 */
export async function cacheAside<T>(redis: RedisClient, key: string, ttlSeconds: number, read: () => Promise<T>, serialize: (value: T) => string, deserialize: (value: string) => T): Promise<T> {
  if (redis.isAvailable() && redis.client) {
    const cached = await redis.client.get(key).catch(() => null);
    if (cached !== null) return deserialize(cached);
  }
  const value = await read();
  if (redis.isAvailable() && redis.client) await redis.client.set(key, serialize(value), 'EX', ttlSeconds).catch(() => undefined);
  return value;
}

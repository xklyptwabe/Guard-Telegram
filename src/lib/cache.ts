import type { RedisClient } from '../db/redis.js';

export async function cacheAside<T>(redis: RedisClient, key: string, ttlSeconds: number, read: () => Promise<T>, serialize: (value: T) => string, deserialize: (value: string) => T): Promise<T> {
  if (redis.isAvailable() && redis.client) {
    const cached = await redis.client.get(key).catch(() => null);
    if (cached !== null) return deserialize(cached);
  }
  const value = await read();
  if (redis.isAvailable() && redis.client) await redis.client.set(key, serialize(value), 'EX', ttlSeconds).catch(() => undefined);
  return value;
}

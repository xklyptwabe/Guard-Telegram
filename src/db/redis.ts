import { Redis } from 'ioredis';

import type { AppConfig } from '../config.js';
import type { Logger } from '../lib/logger.js';

export interface RedisClient {
  readonly client: Redis | undefined;
  isAvailable(): boolean;
  close(): Promise<void>;
}

type RedisConfig = Pick<
  AppConfig,
  'redisEnabled' | 'redisHost' | 'redisPort' | 'redisDb' | 'redisKeyPrefix' | 'redisUsername' | 'redisPassword' | 'redisTls' | 'redisTlsRejectUnauthorized'
>;

export function redisConnectionOptions(config: RedisConfig) {
  return {
    host: config.redisHost,
    port: config.redisPort,
    db: config.redisDb,
    keyPrefix: config.redisKeyPrefix,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    ...(config.redisPassword ? { username: config.redisUsername, password: config.redisPassword } : {}),
    ...(config.redisTls ? { tls: { rejectUnauthorized: config.redisTlsRejectUnauthorized } } : {}),
  };
}

export async function createRedis(config: RedisConfig, logger: Logger): Promise<RedisClient> {
  if (!config.redisEnabled) {
    return { client: undefined, isAvailable: () => false, close: () => Promise.resolve() };
  }
  const client = new Redis(redisConnectionOptions(config));
  client.on('error', (error: Error) => logger.warn({ event: 'redis.degraded', error: { name: error.name, message: error.message } }));
  try {
    await client.connect();
    logger.info({ event: 'redis.connected' });
    return {
      client,
      isAvailable: () => client.status === 'ready',
      close: async () => {
        await client.quit();
      },
    };
  } catch (error: unknown) {
    logger.warn({ event: 'redis.degraded', error: { name: error instanceof Error ? error.name : 'UnknownError', message: error instanceof Error ? error.message : String(error) } });
    client.disconnect();
    return { client: undefined, isAvailable: () => false, close: () => Promise.resolve() };
  }
}

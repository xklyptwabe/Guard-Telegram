import type { AppConfig } from '../config.js';
import type { RedisClient } from '../db/redis.js';
import type { ObjectStorage } from './storage.js';
import type { RabbitMqBridge } from './rabbitmq.js';

export interface HealthSnapshot {
  readonly status: 'ok' | 'degraded' | 'unhealthy';
  readonly transport: AppConfig['telegramTransport'];
  readonly database: 'ready';
  readonly redis: 'disabled' | 'ready' | 'degraded';
  readonly storage: 'disabled' | 'ready';
  readonly rabbitMq: 'disabled' | 'ready' | 'unhealthy';
}

export function healthSnapshot(config: Pick<AppConfig, 'telegramTransport' | 'redisEnabled' | 's3Enabled' | 'rabbitMqEnabled'>, redis: RedisClient, storage: ObjectStorage, rabbitMq: RabbitMqBridge): HealthSnapshot {
  const redisState: HealthSnapshot['redis'] = !config.redisEnabled ? 'disabled' : redis.isAvailable() ? 'ready' : 'degraded';
  const rabbitMqState: HealthSnapshot['rabbitMq'] = !config.rabbitMqEnabled ? 'disabled' : rabbitMq.enabled ? 'ready' : 'unhealthy';
  return {
    status: rabbitMqState === 'unhealthy' ? 'unhealthy' : redisState === 'degraded' ? 'degraded' : 'ok',
    transport: config.telegramTransport,
    database: 'ready',
    redis: redisState,
    storage: storage.enabled ? 'ready' : 'disabled',
    rabbitMq: rabbitMqState,
  };
}

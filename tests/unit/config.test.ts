import { describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/config.js';
import { redisConnectionOptions } from '../../src/db/redis.js';

const baseEnv = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  DATABASE_URL: 'postgres://bot:password@db.example.internal:5432/telegram',
};

describe('validateConfig', () => {
  it('accepts the secure long-polling baseline', () => {
    const config = validateConfig(baseEnv);
    expect(config.telegramTransport).toBe('long_polling');
    expect(config.redisEnabled).toBe(false);
    expect(config.telegramAllowedUpdates).toEqual(['message', 'callback_query', 'my_chat_member']);
  });

  it('rejects an insecure RabbitMQ endpoint before startup', () => {
    expect(() => validateConfig({ ...baseEnv, RABBITMQ_ENABLED: 'true', RABBITMQ_URL: 'amqp://mq.example.internal' })).toThrow(/amqps/);
  });

  it('requires HTTPS URL and a strong secret for webhook transport', () => {
    expect(() => validateConfig({ ...baseEnv, TELEGRAM_TRANSPORT: 'webhook', TELEGRAM_WEBHOOK_URL: 'http://bot.example/hook', TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow();
  });

  it('rejects plaintext Redis when the optional service is enabled', () => {
    expect(() => validateConfig({ ...baseEnv, REDIS_ENABLED: 'true', REDIS_TLS: 'false' })).toThrow(/Redis requires TLS/);
  });

  it('uses the default Redis ACL user with REDIS_PASSWORD', () => {
    const config = validateConfig({ ...baseEnv, REDIS_ENABLED: 'true', REDIS_PASSWORD: 'redis-password' });

    expect(config.redisUsername).toBe('default');
    expect(redisConnectionOptions(config)).toMatchObject({ username: 'default', password: 'redis-password' });
  });
});

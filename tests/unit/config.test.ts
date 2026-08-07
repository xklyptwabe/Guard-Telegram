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

  it('accepts a dedicated audit retention PostgreSQL URL', () => {
    const config = validateConfig({
      ...baseEnv,
      AUDIT_RETENTION_DATABASE_URL: 'postgres://audit_retention:password@db.example.internal:5432/telegram',
    });

    expect(config.auditRetentionDatabaseUrl).toBe('postgres://audit_retention:password@db.example.internal:5432/telegram');
  });

  it('keeps the backend API disabled unless explicitly configured', () => {
    const config = validateConfig(baseEnv);

    expect(config.backendApiEnabled).toBe(false);
    expect(config.backendApiHost).toBe('127.0.0.1');
    expect(config.backendApiPort).toBe(8081);
    expect(config.backendApiPrincipals).toEqual([]);
  });

  it('requires backend API tokens when the backend API is enabled', () => {
    expect(() => validateConfig({ ...baseEnv, BACKEND_API_ENABLED: 'true' })).toThrow(/BACKEND_API_TOKENS/);
  });

  it('parses backend API principals from JSON configuration', () => {
    const config = validateConfig({
      ...baseEnv,
      BACKEND_API_ENABLED: 'true',
      BACKEND_API_TOKENS: JSON.stringify([
        {
          token: 'test-token-123456',
          actorId: 'operator-1',
          permissions: ['audit.events.read'],
          allowedChatIds: ['-1001'],
          systemAdmin: false,
        },
      ]),
    });

    expect(config.backendApiPrincipals).toEqual([
      {
        token: 'test-token-123456',
        actorId: 'operator-1',
        permissions: ['audit.events.read'],
        allowedChatIds: ['-1001'],
        systemAdmin: false,
      },
    ]);
  });

  it('rejects duplicate backend API bearer tokens', () => {
    expect(() =>
      validateConfig({
        ...baseEnv,
        BACKEND_API_ENABLED: 'true',
        BACKEND_API_TOKENS: JSON.stringify([
          { token: 'duplicate-token-1', actorId: 'operator-1' },
          { token: 'duplicate-token-1', actorId: 'operator-2' },
        ]),
      }),
    ).toThrow(/duplicate token/);
  });

  it('rejects the reserved platform tenant for a non-system backend principal', () => {
    expect(() =>
      validateConfig({
        ...baseEnv,
        BACKEND_API_ENABLED: 'true',
        BACKEND_API_TOKENS: JSON.stringify([
          {
            token: 'platform-token-123456',
            actorId: 'operator-1',
            permissions: ['audit.events.read'],
            allowedChatIds: ['__platform__'],
            systemAdmin: false,
          },
        ]),
      }),
    ).toThrow(/reserved for system administrators/);
  });
});

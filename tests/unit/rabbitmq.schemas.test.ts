import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { platformRabbitActionSchemas, registerPlatformRabbitActionSchemas } from '../../src/lib/rabbitmq.js';

describe('platform Rabbit action schemas (round-3)', () => {
  it('registers built-in types and rejects unknown keys on platform.ping', () => {
    const registered = new Map<string, z.ZodType>();
    registerPlatformRabbitActionSchemas({
      registerActionSchema(type, schema) {
        registered.set(type, schema);
      },
    });
    expect(registered.has('platform.ping')).toBe(true);
    expect(platformRabbitActionSchemas['platform.ping'].parse({ reason: 'health' })).toEqual({ reason: 'health' });
    expect(() => platformRabbitActionSchemas['platform.ping'].parse({ reason: 'x', message: { text: 'raw update' } })).toThrow();
  });
});

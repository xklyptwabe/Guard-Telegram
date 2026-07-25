import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { TelegramBotModule } from '../../src/core/contracts.js';
import { validateModules } from '../../src/core/loader.js';

const command = {
  id: 'example.ping',
  name: 'ping',
  moduleId: 'example',
  descriptionKey: 'commands.ping',
  permission: 'none' as const,
  cooldownMs: 0,
  argsSchema: z.string(),
  execute: async (): Promise<void> => undefined,
};

const validModule: TelegramBotModule = {
  id: 'example',
  name: 'Example',
  description: 'Test module',
  global: false,
  defaultEnabled: false,
  commands: [command],
};

describe('validateModules', () => {
  it('accepts a unique local module', () => {
    expect(() => validateModules([validModule])).not.toThrow();
  });

  it('rejects duplicate Telegram command names', () => {
    expect(() => validateModules([validModule, { ...validModule, id: 'other', commands: [{ ...command, id: 'other.ping', moduleId: 'other' }] }])).toThrow(/Duplicate command name/);
  });

  it('requires global and local defaults to match their module class', () => {
    expect(() => validateModules([{ ...validModule, defaultEnabled: true }])).toThrow(/default disabled/);
  });
});

import { BotError, type Context } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditFinalizationPendingError } from '../../src/lib/moderation/pendingOperationsOutbox.js';
import { startLongPolling, startWebhook, UpdateBusyError } from '../../src/core/updates.js';
import type { AppConfig } from '../../src/config.js';
import type { Logger } from '../../src/lib/logger.js';

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function wrap(error: Error): BotError {
  return new BotError(error, { update: { update_id: 10 } } as Context);
}

describe('startLongPolling offset (round-5)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not advance Telegram offset when handleUpdate throws a wrapped busy error', async () => {
    const offsets: number[] = [];
    let releaseSecond: (() => void) | undefined;
    const secondFetch = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const bot = {
      api: {
        getUpdates: vi.fn(async (args: { offset: number }, signal?: AbortSignal) => {
          offsets.push(args.offset);
          if (offsets.length === 1) return [{ update_id: 10 }];
          releaseSecond?.();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return [];
        }),
      },
      handleUpdate: vi.fn(async () => {
        throw wrap(new UpdateBusyError('10', 'lease_held'));
      }),
    };

    const transport = startLongPolling(bot as never, { telegramAllowedUpdates: ['message'], telegramRunnerConcurrency: 1 }, logger());
    await secondFetch;
    await transport.stop();

    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBe(0);
    expect(bot.handleUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('startWebhook HTTP (round-5)', () => {
  const secret = 'webhook-secret-16ch';
  const port = 18766;

  function config(): AppConfig {
    return {
      telegramWebhookUrl: `https://example.test/hook`,
      telegramWebhookSecret: secret,
      telegramWebhookPort: port,
      telegramWebhookHost: '127.0.0.1',
      telegramAllowedUpdates: ['message'],
    } as AppConfig;
  }

  async function post(statusFrom: Error): Promise<number> {
    const bot = {
      api: { setWebhook: vi.fn(async () => true) },
      handleUpdate: vi.fn(async () => {
        throw wrap(statusFrom);
      }),
    };
    const transport = await startWebhook(bot as never, config(), logger());
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify({ update_id: 10 }),
      });
      return response.status;
    } finally {
      await transport.stop();
    }
  }

  it('answers 409 when handleUpdate throws BotError(UpdateBusyError)', async () => {
    await expect(post(new UpdateBusyError('10', 'lease_held'))).resolves.toBe(409);
  });

  it('answers 503 when handleUpdate throws BotError(AuditFinalizationPendingError)', async () => {
    await expect(post(new AuditFinalizationPendingError('owed'))).resolves.toBe(503);
  });
});

import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config.js';
import { registerCommands } from '../../src/core/commandRegistrar.js';
import { CommandDispatcher } from '../../src/core/dispatcher.js';
import { startWebhook } from '../../src/core/updates.js';
import type { AuditService } from '../../src/lib/auditService.js';
import type { Cooldowns } from '../../src/lib/cooldowns.js';
import { runWithModuleContext, runWithUpdateContext } from '../../src/lib/context.js';
import type { EventBus } from '../../src/lib/eventBus.js';
import type { Logger } from '../../src/lib/logger.js';
import { AuditFinalizationPendingError, type PendingOperationsOutbox, type PendingOperationResolvers } from '../../src/lib/moderation/pendingOperationsOutbox.js';
import { ReplyService } from '../../src/lib/reply.js';
import type { ModuleRegistry } from '../../src/core/registry.js';

type OutboxInput = {
  kind: string;
  chatId: string;
  idempotencyKey: string;
  supersessionKey?: string;
  requestPayload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  recoveryMetadata?: Record<string, unknown>;
  auditEvent?: { eventType: string; eventVersion: string; moduleId?: string };
};

function logger(): Logger {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function outboxDouble(auditFinalized = true) {
  const writes: OutboxInput[] = [];
  const outbox = {
    execute: vi.fn(async (input: OutboxInput, executor: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>) => {
      writes.push(input);
      const result = await executor(input.requestPayload);
      return {
        row: { id: 'operation-1' },
        outcome: { status: 'succeeded', result },
        duplicate: false,
        isFinal: true,
        auditFinalized,
      };
    }),
  } as unknown as PendingOperationsOutbox;
  const resolvers = { register: vi.fn() } as unknown as PendingOperationResolvers;
  return { outbox, resolvers, writes };
}

describe('Telegram mutation write-ahead coverage', () => {
  it('persists a safe sendMessage intent before the API call and excludes message text', async () => {
    const marker = 'FORBIDDEN_REPLY_TEXT_93c1';
    const { outbox, resolvers, writes } = outboxDouble();
    const sendMessage = vi.fn(async () => {
      expect(writes).toHaveLength(1);
      return { message_id: 77 };
    });
    const reply = new ReplyService({ telegramTopicFallbackToChat: true }, logger(), outbox, resolvers);
    const ctx = {
      chat: { id: -1001, type: 'supergroup' },
      update: { update_id: 501, message: { message_id: 4, date: 1, chat: { id: -1001, type: 'supergroup' }, text: '/safe' } },
      api: { sendMessage },
    } as unknown as Context;

    await runWithUpdateContext({ updateId: '501', botId: '42', chatId: '-1001' }, () => reply.send(ctx, marker));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(writes[0]).toMatchObject({ kind: 'integration.telegram.sendMessage', chatId: '-1001' });
    expect(writes[0]?.requestPayload).toMatchObject({ textDigest: expect.stringMatching(/^[a-f0-9]{64}$/), sizeBytes: Buffer.byteLength(marker) });
    expect(JSON.stringify(writes[0])).not.toContain(marker);
  });

  it('carries the command module through sendMessage intent and restart recovery metadata', async () => {
    const { outbox, resolvers, writes } = outboxDouble();
    const reply = new ReplyService({ telegramTopicFallbackToChat: true }, logger(), outbox, resolvers);
    const ctx = {
      chat: { id: -1001, type: 'supergroup' },
      update: { update_id: 504, message: { message_id: 4, date: 1, chat: { id: -1001, type: 'supergroup' } } },
      api: { sendMessage: vi.fn(async () => ({ message_id: 79 })) },
    } as unknown as Context;

    await runWithUpdateContext({ updateId: '504', botId: '42', chatId: '-1001' }, () =>
      runWithModuleContext('moderation', () => reply.send(ctx, 'safe')),
    );

    expect(writes[0]?.metadata).toMatchObject({ moduleId: 'moderation' });
    expect(writes[0]?.recoveryMetadata).toMatchObject({ moduleId: 'moderation' });
    expect(writes[0]?.auditEvent).toMatchObject({ eventType: 'integration.action', moduleId: 'moderation' });
  });

  it('propagates sendMessage audit debt through the update retry contract', async () => {
    const { outbox, resolvers } = outboxDouble(false);
    const reply = new ReplyService({ telegramTopicFallbackToChat: true }, logger(), outbox, resolvers);
    const ctx = {
      chat: { id: -1001, type: 'supergroup' },
      update: { update_id: 503, message: { message_id: 4, date: 1, chat: { id: -1001, type: 'supergroup' } } },
      api: { sendMessage: vi.fn(async () => ({ message_id: 78 })) },
    } as unknown as Context;

    await expect(runWithUpdateContext({ updateId: '503', botId: '42', chatId: '-1001' }, () => reply.send(ctx, 'safe'))).rejects.toBeInstanceOf(AuditFinalizationPendingError);
  });

  it('persists each setMyCommands intent before changing the Telegram menu', async () => {
    const { outbox, resolvers, writes } = outboxDouble();
    const setMyCommands = vi.fn(async () => {
      expect(writes.length).toBeGreaterThan(0);
      return true;
    });
    const bot = { api: { setMyCommands }, command: vi.fn(), on: vi.fn() };
    const dispatcher = { dispatchCommand: vi.fn(), dispatchCallback: vi.fn() };
    const i18n = { t: vi.fn((key: string) => key) };

    await registerCommands(bot as never, [], dispatcher as never, i18n as never, logger(), outbox, resolvers);

    expect(setMyCommands).toHaveBeenCalledTimes(3);
    expect(writes.map((write) => write.kind)).toEqual([
      'integration.telegram.setMyCommands',
      'integration.telegram.setMyCommands',
      'integration.telegram.setMyCommands',
    ]);
    expect(writes.every((write) => write.requestPayload.commands instanceof Array)).toBe(true);
    expect(writes.map((write) => write.supersessionKey)).toEqual([
      'telegram.setMyCommands:default',
      'telegram.setMyCommands:ru',
      'telegram.setMyCommands:en',
    ]);
  });

  it('persists a redacted setWebhook intent before sending the URL and secret', async () => {
    const secret = 'FORBIDDEN_WEBHOOK_SECRET_a1c9';
    const webhookUrl = 'https://example.test/hidden-webhook-path';
    const { outbox, resolvers, writes } = outboxDouble();
    const setWebhook = vi.fn(async () => {
      expect(writes).toHaveLength(1);
      return true;
    });
    const bot = { api: { setWebhook }, handleUpdate: vi.fn() };
    const config = {
      telegramWebhookUrl: webhookUrl,
      telegramWebhookSecret: secret,
      telegramWebhookPort: 0,
      telegramWebhookHost: '127.0.0.1',
      telegramAllowedUpdates: ['message'],
    } as AppConfig;

    const transport = await startWebhook(bot as never, config, logger(), outbox, resolvers);
    await transport.stop();

    expect(setWebhook).toHaveBeenCalledWith(webhookUrl, expect.objectContaining({ secret_token: secret }));
    expect(writes[0]).toMatchObject({ kind: 'integration.telegram.setWebhook', chatId: 'platform' });
    expect(writes[0]?.requestPayload).toHaveProperty('webhookUrlDigest');
    expect(JSON.stringify(writes[0])).not.toContain(secret);
    expect(JSON.stringify(writes[0])).not.toContain(webhookUrl);
  });

  it('persists a redacted answerCallbackQuery intent before answering', async () => {
    const callbackMarker = 'FORBIDDEN_CALLBACK_PAYLOAD_f921';
    const responseMarker = 'FORBIDDEN_CALLBACK_RESPONSE_11b0';
    const { outbox, resolvers, writes } = outboxDouble();
    const answerCallbackQuery = vi.fn(async () => {
      expect(writes).toHaveLength(1);
      return true;
    });
    const reply = { send: vi.fn(async () => undefined) };
    const dispatcher = new CommandDispatcher(
      [],
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleRegistry,
      { take: vi.fn(() => true), release: vi.fn() } as unknown as Cooldowns,
      reply as never,
      { publish: vi.fn() } as unknown as EventBus,
      { t: vi.fn(() => responseMarker) } as never,
      logger(),
      {} as AuditService,
      outbox,
      resolvers,
    );
    const ctx = {
      chat: { id: -1002, type: 'supergroup' },
      from: { id: 7, is_bot: false, first_name: 'Tester' },
      callbackQuery: { id: 'callback-id-secret', data: callbackMarker },
      update: { update_id: 502, callback_query: { id: 'callback-id-secret', from: { id: 7, is_bot: false, first_name: 'Tester' }, data: callbackMarker } },
      answerCallbackQuery,
    } as unknown as Context;

    await runWithUpdateContext({ updateId: '502', botId: '42', chatId: '-1002' }, () => dispatcher.dispatchCallback(ctx));

    expect(answerCallbackQuery).toHaveBeenCalledWith({ text: responseMarker });
    expect(writes[0]).toMatchObject({ kind: 'integration.telegram.answerCallbackQuery', chatId: '-1002' });
    expect(writes[0]?.requestPayload).toEqual({
      callbackIdDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      textDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sizeBytes: Buffer.byteLength(responseMarker),
    });
    expect(JSON.stringify(writes[0])).not.toContain(callbackMarker);
    expect(JSON.stringify(writes[0])).not.toContain(responseMarker);
    expect(JSON.stringify(writes[0])).not.toContain('callback-id-secret');
  });
});

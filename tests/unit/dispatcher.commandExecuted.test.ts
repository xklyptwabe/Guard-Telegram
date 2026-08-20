import type { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { TelegramCommandDefinition } from '../../src/core/contracts.js';
import { CommandDispatcher } from '../../src/core/dispatcher.js';
import type { ModuleRegistry } from '../../src/core/registry.js';
import { AuditPolicyDisabledError, type AuditService } from '../../src/lib/auditService.js';
import type { Cooldowns } from '../../src/lib/cooldowns.js';
import { runWithUpdateContext } from '../../src/lib/context.js';
import type { EventBus } from '../../src/lib/eventBus.js';
import type { Logger } from '../../src/lib/logger.js';
import type { ReplyService } from '../../src/lib/reply.js';

function fakeCtx(chatId: number, userId: number): Context {
  return {
    chat: { id: chatId, type: 'private' },
    from: { id: userId, language_code: 'en' },
  } as unknown as Context;
}

function fakeCommand(overrides: Partial<TelegramCommandDefinition> = {}): TelegramCommandDefinition {
  return {
    id: 'test-cmd',
    name: 'test',
    moduleId: 'test-module',
    descriptionKey: 'test.description',
    permission: 'none',
    cooldownMs: 0,
    argsSchema: z.string(),
    execute: vi.fn(async () => undefined),
    ...overrides,
  };
}

/** Records every `recordEntityChange` call; never reports a duplicate unless `alwaysDuplicate` is set. */
function fakeAuditService(options: { alwaysDuplicate?: boolean; throwOnRecord?: boolean; policyDisabled?: boolean } = {}) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: () => Promise<unknown>) => {
      if (options.policyDisabled) throw new AuditPolicyDisabledError('command.executed', 'v1');
      if (options.throwOnRecord) throw new Error('simulated audit failure');
      if (options.alwaysDuplicate) return { eventId: 'evt-existing', subjectSequence: 1, duplicate: true };
      const result = await mutate();
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
  } as unknown as AuditService;
  return { audit, calls };
}

function fakeDispatcher(command: TelegramCommandDefinition, audit: AuditService) {
  const registry = { isEnabled: vi.fn(async () => true) } as unknown as ModuleRegistry;
  const cooldowns = { take: vi.fn(() => true), release: vi.fn() } as unknown as Cooldowns;
  const reply = { send: vi.fn(async () => undefined) } as unknown as ReplyService;
  const events = { publish: vi.fn() } as unknown as EventBus;
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const i18n = { t: vi.fn((key: string) => key) } as unknown as import('i18next').i18n;
  const dispatcher = new CommandDispatcher([command], registry, cooldowns, reply, events, i18n, logger, audit);
  return { dispatcher, reply, logger };
}

describe('CommandDispatcher — command.executed audit wiring', () => {
  it('records success:true after a command completes without throwing', async () => {
    const command = fakeCommand();
    const { audit, calls } = fakeAuditService();
    const { dispatcher } = fakeDispatcher(command, audit);
    const ctx = fakeCtx(1, 2);

    await runWithUpdateContext({ updateId: 'upd-1' }, () => dispatcher.dispatchCommand(ctx, 'test', ''));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { input: { idempotencyKey: string }; result: { after: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ commandId: 'test', success: true, argsRedacted: true });
    expect(call.input.idempotencyKey).toBe('command.executed:telegram-update:unscoped-bot:upd-1:1:2:test');
  });

  it('records success:false when the command throws, and still sends the error reply', async () => {
    const command = fakeCommand({
      execute: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { audit, calls } = fakeAuditService();
    const { dispatcher, reply } = fakeDispatcher(command, audit);
    const ctx = fakeCtx(1, 2);

    await runWithUpdateContext({ updateId: 'upd-2' }, () => dispatcher.dispatchCommand(ctx, 'test', ''));

    expect(calls).toHaveLength(1);
    const call = calls[0] as { result: { after: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({ success: false });
    expect(reply.send).toHaveBeenCalled(); // the internal-error reply still went out
  });

  it('keys idempotencyKey on the Telegram update — a redelivered Update must dedupe at the audit layer', async () => {
    const command = fakeCommand();
    const { audit, calls } = fakeAuditService({ alwaysDuplicate: true });
    const { dispatcher } = fakeDispatcher(command, audit);
    const ctx = fakeCtx(1, 2);

    await runWithUpdateContext({ updateId: 'upd-3' }, () => dispatcher.dispatchCommand(ctx, 'test', ''));

    // `mutate` never runs on a duplicate — nothing gets pushed to `calls`,
    // but recordEntityChange must still have been called (and not thrown).
    expect(audit.recordEntityChange).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('never captures raw arguments — argsRedacted is always true regardless of input', async () => {
    const command = fakeCommand({ argsSchema: z.string() });
    const { audit, calls } = fakeAuditService();
    const { dispatcher } = fakeDispatcher(command, audit);
    const ctx = fakeCtx(1, 2);

    await runWithUpdateContext({ updateId: 'upd-4' }, () => dispatcher.dispatchCommand(ctx, 'test', 'super secret argument text'));

    const call = calls[0] as { result: { after: Record<string, unknown> } };
    expect(call.result.after.argsRedacted).toBe(true);
    expect(JSON.stringify(call.result.after)).not.toContain('super secret argument text');
  });

  it('logs and skips (does not throw) when there is no update context', async () => {
    const command = fakeCommand();
    const { audit, calls } = fakeAuditService();
    const { dispatcher, logger } = fakeDispatcher(command, audit);
    const ctx = fakeCtx(1, 2);

    // Deliberately NOT wrapped in runWithUpdateContext.
    await dispatcher.dispatchCommand(ctx, 'test', '');

    expect(calls).toHaveLength(0);
    expect(audit.recordEntityChange).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.command_executed.missing_update_context' }));
  });

  it('BOTS-9 round-2 BLOCKER-4: a policy-disabled audit is a normal no-op — command flow and reply are unaffected', async () => {
    const command = fakeCommand();
    const { audit } = fakeAuditService({ policyDisabled: true });
    const { dispatcher, reply } = fakeDispatcher(command, audit);
    const ctx = fakeCtx(1, 2);

    await expect(runWithUpdateContext({ updateId: 'upd-5' }, () => dispatcher.dispatchCommand(ctx, 'test', ''))).resolves.toBeUndefined();

    expect(command.execute).toHaveBeenCalled(); // the actual command still ran successfully
    expect(reply.send).not.toHaveBeenCalledWith(ctx, 'common.internalError'); // success path, not the error path
  });

  it('BOTS-9 round-2 BLOCKER-4/HIGH-8: an INFRASTRUCTURE audit failure propagates so the durable inbox retries until the record lands', async () => {
    const command = fakeCommand();
    const { audit } = fakeAuditService({ throwOnRecord: true });
    const { dispatcher, reply, logger } = fakeDispatcher(command, audit);
    const ctx = fakeCtx(1, 2);

    await expect(runWithUpdateContext({ updateId: 'upd-5' }, () => dispatcher.dispatchCommand(ctx, 'test', ''))).rejects.toThrow(/still owed/);

    expect(command.execute).toHaveBeenCalled(); // the command itself ran
    expect(reply.send).not.toHaveBeenCalledWith(ctx, 'common.internalError'); // no misleading error reply — the command succeeded
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.command_executed.failed' }));
  });

  it('does not audit commands rejected before execution (feature disabled)', async () => {
    const command = fakeCommand();
    const { audit, calls } = fakeAuditService();
    const registry = { isEnabled: vi.fn(async () => false) } as unknown as ModuleRegistry;
    const cooldowns = { take: vi.fn(() => true), release: vi.fn() } as unknown as Cooldowns;
    const reply = { send: vi.fn(async () => undefined) } as unknown as ReplyService;
    const events = { publish: vi.fn() } as unknown as EventBus;
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const i18n = { t: vi.fn((key: string) => key) } as unknown as import('i18next').i18n;
    const dispatcher = new CommandDispatcher([command], registry, cooldowns, reply, events, i18n, logger, audit);
    const ctx = fakeCtx(1, 2);

    await runWithUpdateContext({ updateId: 'upd-6' }, () => dispatcher.dispatchCommand(ctx, 'test', ''));

    expect(command.execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(audit.recordEntityChange).not.toHaveBeenCalled();
  });
});

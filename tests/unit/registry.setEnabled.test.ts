import { describe, expect, it, vi } from 'vitest';

import type { TelegramBotModule } from '../../src/core/contracts.js';
import { MissingModuleAuditIdempotencyKeyError, ModuleRegistry } from '../../src/core/registry.js';
import type { AuditService } from '../../src/lib/auditService.js';
import type { DrizzleDatabase } from '../../src/db/client.js';
import type { EventBus } from '../../src/lib/eventBus.js';
import type { Logger } from '../../src/lib/logger.js';
import { runWithUpdateContext } from '../../src/lib/context.js';

function fakeModule(id: string, defaultEnabled: boolean): TelegramBotModule {
  return { id, name: id, description: id, global: false, defaultEnabled };
}

/**
 * Minimal fake of BOTS-6's `AuditService.recordEntityChange`: invokes the
 * `mutate` callback with a fake transaction that reports `existingEnabled`
 * as the current DB row (or no row at all, if undefined), and records
 * every call so tests can assert on both the `AuditEventInput` and the
 * `mutate` callback's return value.
 */
function fakeAuditService(existingEnabled: boolean | undefined) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const fakeTx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => (existingEnabled === undefined ? [] : [{ enabled: existingEnabled }]),
          }),
        }),
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  };
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: (tx: unknown) => Promise<unknown>) => {
      const result = await mutate(fakeTx);
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
  } as unknown as AuditService;
  return { audit, calls };
}

function fakeRegistry(module: TelegramBotModule, existingEnabled: boolean | undefined) {
  const { audit, calls } = fakeAuditService(existingEnabled);
  const events = { publish: vi.fn() } as unknown as EventBus;
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const db = {} as unknown as DrizzleDatabase;
  const registry = new ModuleRegistry([module], db, audit, events, logger);
  return { registry, calls, events, logger };
}

let updateCounter = 0;

async function setEnabledInUpdate(
  registry: ModuleRegistry,
  chatId: string,
  moduleId: string,
  enabled: boolean,
  actorId?: string,
): Promise<void> {
  updateCounter += 1;
  await runWithUpdateContext(
    { updateId: `test-update-${updateCounter}`, chatId, ...(actorId !== undefined ? { userId: actorId } : {}) },
    () => registry.setEnabled(chatId, moduleId, enabled, actorId),
  );
}

/**
 * Fake matching the real `recordEntityChange`'s behavior on a genuine
 * idempotencyKey collision: `mutate` is never invoked at all (the real
 * implementation returns before calling it — see auditService.ts's early
 * `if (existing[0]) return { ..., duplicate: true }`), and the result
 * reports `duplicate: true`.
 */
function fakeRegistryDuplicate(module: TelegramBotModule) {
  const mutate = vi.fn();
  const audit = {
    recordEntityChange: vi.fn(async () => ({ eventId: 'evt-existing', subjectSequence: 1, duplicate: true })),
  } as unknown as AuditService;
  const events = { publish: vi.fn() } as unknown as EventBus;
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const db = {} as unknown as DrizzleDatabase;
  const registry = new ModuleRegistry([module], db, audit, events, logger);
  return { registry, events, logger, mutate };
}

describe('ModuleRegistry.setEnabled — BOTS-7/BOTS-6 wiring', () => {
  it('tracks source as "default" before an override exists, and "override" once one is set', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined); // no row yet — inheriting the default

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', false, 'user-1');

    const call = calls[0] as { result: { before: Record<string, unknown>; after: Record<string, unknown> } };
    expect(call.result.before).toMatchObject({ enabled: true, source: 'default' });
    expect(call.result.after).toMatchObject({ enabled: false, source: 'override' });
  });

  it('tracks source as "default" again once the value is set back to the module default (row deleted)', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, false); // an override row exists: enabled=false

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', true, 'user-1'); 

    const call = calls[0] as { result: { before: Record<string, unknown>; after: Record<string, unknown> } };
    expect(call.result.before).toMatchObject({ enabled: false, source: 'override' });
    expect(call.result.after).toMatchObject({ enabled: true, source: 'default' });
  });

  it('reports a computed-but-empty ChangeSet (not omitted) when the effective value does not actually change', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', true, 'user-1'); 

    const call = calls[0] as { result: { changes: { status: string; fields: Record<string, unknown> } } };
    // Per Maxim: store the full ChangeSet, not just fields — 'computed with
    // empty fields' (a real, confirmed noop) is meaningfully different from
    // no changes info at all, and dropping it would lose that signal.
    expect(call.result.changes).toEqual({ status: 'computed', fields: {} });
  });

  it('returns a current entity snapshot status for observed module state after snapshots', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', false, 'user-1');

    const call = calls[0] as { result: { snapshotStatus?: string } };
    expect(call.result.snapshotStatus).toBe('current');
  });

  it('passes actorId through to the AuditEventInput when the caller provides one', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', false, 'user-42');

    const call = calls[0] as { input: { actorId?: string; actorType?: string } };
    expect(call.input.actorId).toBe('user-42');
    expect(call.input.actorType).toBe('telegram_user');
  });

  it('omits actorId entirely (not undefined) when the caller does not provide one', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', false);

    const call = calls[0] as { input: Record<string, unknown> };
    expect('actorId' in call.input).toBe(false);
  });

  it('returns operation metadata from mutate without static event-type metadata', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', false, 'user-1');

    const call = calls[0] as { result: { metadata?: Record<string, unknown> } };
    expect(call.result.metadata).toEqual({ operation: 'update' });
    expect(call.result.metadata).not.toHaveProperty('severity');
    expect(call.result.metadata).not.toHaveProperty('siteVisible');
    expect(call.result.metadata).not.toHaveProperty('canBeDisabled');
  });

  it('still performs the real DB write and fires module lifecycle hooks/events as before', async () => {
    const onEnable = vi.fn();
    const module: TelegramBotModule = { ...fakeModule('welcome', true), onEnable };
    const { registry } = fakeRegistry(module, false);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', true, 'user-1');

    expect(onEnable).toHaveBeenCalledWith('chat-1');
  });

  it('classifies a redundant-override cleanup as update, not noop — the boolean is unchanged but the row/source actually changes', async () => {
    // defaultEnabled=true, but there's an existing *redundant* override
    // row already set to true (e.g. an admin ran /module_enable when it
    // was already true by default). Calling setEnabled(true) again looks
    // like a value-noop, but it actually deletes that stray row and flips
    // source override → default — a real state change.
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, true); // existing override row: enabled=true

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', true, 'user-1');

    const call = calls[0] as { result: { before: Record<string, unknown>; after: Record<string, unknown>; changes: { status: string; fields: Record<string, unknown> } } };
    expect(call.result.before).toMatchObject({ enabled: true, source: 'override' });
    expect(call.result.after).toMatchObject({ enabled: true, source: 'default' });
    // Because operation is 'update' (not 'noop'), changes must reflect the
    // source flip even though `enabled` itself didn't change.
    expect(call.result.changes.fields).toHaveProperty('source');
  });

  it('uses the Telegram update as the module.state.changed idempotency key scope', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, true);

    await runWithUpdateContext({ updateId: 'update-42', chatId: 'chat-1', userId: 'user-1' }, () =>
      registry.setEnabled('chat-1', 'welcome', true, 'user-1'),
    );

    const call = calls[0] as { input: { idempotencyKey: string } };
    expect(call.input.idempotencyKey).toBe('module.state.changed:telegram-update:update-42:chat-1:welcome');
  });

  it('uses an explicit idempotency key when setEnabled is called outside a Telegram update context', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, true);

    await registry.setEnabled('chat-1', 'welcome', true, {
      actorId: 'user-1',
      idempotencyKey: 'manual-operation:42',
    });

    const call = calls[0] as { input: { actorId?: string; idempotencyKey: string } };
    expect(call.input.actorId).toBe('user-1');
    expect(call.input.idempotencyKey).toBe('manual-operation:42');
  });

  it('rejects a non-context setEnabled call without an explicit idempotency key', async () => {
    const module = fakeModule('welcome', true);
    const { registry } = fakeRegistry(module, true);

    await expect(registry.setEnabled('chat-1', 'welcome', true, 'user-1')).rejects.toThrow(
      MissingModuleAuditIdempotencyKeyError,
    );
  });

  it('on a genuine duplicate (idempotencyKey collision), skips onEnable/onDisable, the event bus publish, and the info log — mutate never ran, nothing actually changed', async () => {
    const onEnable = vi.fn();
    const module: TelegramBotModule = { ...fakeModule('welcome', true), onEnable };
    const { registry, events, logger } = fakeRegistryDuplicate(module);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', false, 'user-1');

    // Regression test: recordEntityChange's return value used to be
    // discarded entirely, so a replayed Telegram Update (the exact case
    // idempotencyKey exists to protect against) would still fire these
    // side effects a second time, even though the DB write itself was
    // correctly deduped.
    expect(onEnable).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'module.state.changed.duplicate_skipped' }),
    );
  });

  it('on a normal (non-duplicate) call, does fire onEnable/publish/info log', async () => {
    const onDisable = vi.fn();
    const module: TelegramBotModule = { ...fakeModule('welcome', true), onDisable };
    const { registry, events, logger } = fakeRegistry(module, true);

    await setEnabledInUpdate(registry, 'chat-1', 'welcome', false, 'user-1');

    expect(onDisable).toHaveBeenCalledWith('chat-1');
    expect(events.publish).toHaveBeenCalledWith('module.state.changed', { chatId: 'chat-1', moduleId: 'welcome', enabled: false });
    expect(logger.info).toHaveBeenCalled();
  });
});

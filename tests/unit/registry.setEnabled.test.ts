import { describe, expect, it, vi } from 'vitest';

import type { TelegramBotModule } from '../../src/core/contracts.js';
import { ModuleRegistry } from '../../src/core/registry.js';
import type { AuditService } from '../../src/lib/auditService.js';
import type { DrizzleDatabase } from '../../src/db/client.js';
import type { EventBus } from '../../src/lib/eventBus.js';
import type { Logger } from '../../src/lib/logger.js';

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
  return { registry, calls };
}

describe('ModuleRegistry.setEnabled — BOTS-7/BOTS-6 wiring', () => {
  it('tracks source as "default" before an override exists, and "override" once one is set', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined); // no row yet — inheriting the default

    await registry.setEnabled('chat-1', 'welcome', false, 'user-1');

    const call = calls[0] as { result: { before: Record<string, unknown>; after: Record<string, unknown> } };
    expect(call.result.before).toMatchObject({ enabled: true, source: 'default' });
    expect(call.result.after).toMatchObject({ enabled: false, source: 'override' });
  });

  it('tracks source as "default" again once the value is set back to the module default (row deleted)', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, false); // an override row exists: enabled=false

    await registry.setEnabled('chat-1', 'welcome', true, 'user-1'); // setting back to the default

    const call = calls[0] as { result: { before: Record<string, unknown>; after: Record<string, unknown> } };
    expect(call.result.before).toMatchObject({ enabled: false, source: 'override' });
    expect(call.result.after).toMatchObject({ enabled: true, source: 'default' });
  });

  it('reports a computed-but-empty ChangeSet (not omitted) when the effective value does not actually change', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await registry.setEnabled('chat-1', 'welcome', true, 'user-1'); // already true by default — a noop

    const call = calls[0] as { result: { changes: { status: string; fields: Record<string, unknown> } } };
    // Per Maxim: store the full ChangeSet, not just fields — 'computed with
    // empty fields' (a real, confirmed noop) is meaningfully different from
    // no changes info at all, and dropping it would lose that signal.
    expect(call.result.changes).toEqual({ status: 'computed', fields: {} });
  });

  it('passes actorId through to the AuditEventInput when the caller provides one', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await registry.setEnabled('chat-1', 'welcome', false, 'user-42');

    const call = calls[0] as { input: { actorId?: string; actorType?: string } };
    expect(call.input.actorId).toBe('user-42');
    expect(call.input.actorType).toBe('telegram_user');
  });

  it('omits actorId entirely (not undefined) when the caller does not provide one', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await registry.setEnabled('chat-1', 'welcome', false);

    const call = calls[0] as { input: Record<string, unknown> };
    expect('actorId' in call.input).toBe(false);
  });

  it('does not bridge severity/siteVisible/canBeDisabled into metadata any more — they now live on seeded audit.event_types', async () => {
    const module = fakeModule('welcome', true);
    const { registry, calls } = fakeRegistry(module, undefined);

    await registry.setEnabled('chat-1', 'welcome', false, 'user-1');

    const call = calls[0] as { input: { metadata?: Record<string, unknown> } };
    // No metadata field at all for this entity-like event: severity/
    // siteVisible/canBeDisabled moved to audit.event_types (seeded via
    // scripts/seedAuditEventTypes.ts), and `operation` isn't knowable yet
    // at input-construction time for events wired through `mutate` — see
    // serviceAdapter.ts's "operation" note.
    expect(call.input.metadata).toBeUndefined();
  });

  it('still performs the real DB write and fires module lifecycle hooks/events as before', async () => {
    const onEnable = vi.fn();
    const module: TelegramBotModule = { ...fakeModule('welcome', true), onEnable };
    const { registry } = fakeRegistry(module, false);

    await registry.setEnabled('chat-1', 'welcome', true, 'user-1');

    expect(onEnable).toHaveBeenCalledWith('chat-1');
  });
});

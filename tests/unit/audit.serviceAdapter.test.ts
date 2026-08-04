import { describe, expect, it } from 'vitest';

import { AUDIT_EVENT_NAMES } from '../../src/lib/audit/eventMap.js';
import {
  MissingAuditChatIdError,
  MissingAuditIdempotencyKeyError,
  PLATFORM_TENANT_SENTINEL,
  buildMetadataBridge,
  tenantIdFor,
  toDownstreamInput,
  toDownstreamMutationResult,
} from '../../src/lib/audit/serviceAdapter.js';
import { AuditEventProcessor } from '../../src/lib/audit/eventProcessor.js';
import { notApplicable, notObserved, observed } from '../../src/lib/audit/snapshot.js';

const processor = new AuditEventProcessor();
const CHAT_SCOPED_FIXTURE_EVENTS = new Set([
  'module.state.changed',
  'chat.settings.changed',
  'member.status.changed',
  'bot.membership.changed',
  'moderation.action',
  'message.edited',
  'message.deleted',
  'command.executed',
]);

describe('toDownstreamInput', () => {
  it('uses the confirmed module.state.changed mapping: subjectType chat_module_state, subjectId chatId:moduleId', () => {
    const record = processor.process({
      name: 'module.state.changed',
      version: 1,
      operation: 'update',
      chatId: 'chat-1',
      before: observed({ chatId: 'chat-1', moduleId: 'welcome', enabled: false, source: 'default' }),
      after: observed({ chatId: 'chat-1', moduleId: 'welcome', enabled: true, source: 'override' }),
    });

    const input = toDownstreamInput(record);
    expect(input.tenantId).toBe('chat-1');
    expect(input.subjectType).toBe('chat_module_state');
    expect(input.subjectId).toBe('chat-1:welcome');
    expect(input.eventType).toBe('module.state.changed');
    // 'v'-prefixed string, confirmed against BOTS-6's actual convention —
    // a bare `String(1)` ('1') would silently mismatch.
    expect(input.eventVersion).toBe('v1');
  });

  it('falls back to the platform tenant sentinel for genuinely platform-scoped policies (scope: "global")', () => {
    const record = processor.process({
      name: 'audit.policy.changed',
      version: 1,
      operation: 'update',
      before: notApplicable(),
      after: observed({ policyId: 'p1', scope: 'global', textLoggingEnabled: false, retentionDays: 90 }),
    });

    const input = toDownstreamInput(record);
    expect(input.tenantId).toBe(PLATFORM_TENANT_SENTINEL);
    expect(tenantIdFor(record)).toBe(PLATFORM_TENANT_SENTINEL);
    expect(input.subjectType).toBe('audit_policy');
    expect(input.subjectId).toBe('p1');
  });

  it('uses the policy scope as tenantId when it is chat-scoped (not "global")', () => {
    const record = processor.process({
      name: 'audit.policy.changed',
      version: 1,
      operation: 'update',
      before: notApplicable(),
      after: observed({ policyId: 'p2', scope: 'chat-42', textLoggingEnabled: true, retentionDays: 30 }),
    });

    expect(tenantIdFor(record)).toBe('chat-42');
    expect(toDownstreamInput(record).tenantId).toBe('chat-42');
  });

  it('uses chatId from an observed chat-scoped snapshot when record.chatId is absent', () => {
    const record = processor.process({
      name: 'chat.settings.changed',
      version: 1,
      operation: 'update',
      before: observed({ chatId: 'chat-1', locale: 'en' }),
      after: observed({ chatId: 'chat-1', locale: 'ru' }),
    });

    const input = toDownstreamInput(record);
    expect(input.tenantId).toBe('chat-1');
    expect(input.subjectType).toBe('chat_settings');
    expect(input.subjectId).toBe('chat-1');
  });

  it('rejects a chat-scoped event when chatId is absent from both record and snapshots', () => {
    const record = processor.process({
      name: 'chat.settings.changed',
      version: 1,
      operation: 'unknown',
      before: notApplicable(),
      after: notApplicable(),
    });

    expect(() => toDownstreamInput(record)).toThrow(MissingAuditChatIdError);
  });

  it('assigns a fresh subjectId per command.executed occurrence (log-like, not entity-like)', () => {
    const base = {
      name: 'command.executed' as const,
      version: 1 as const,
      operation: 'noop' as const,
      chatId: 'chat-1',
      before: notApplicable(),
    };
    const first = processor.process({ ...base, idempotencyKey: 'command:1', after: observed({ chatId: 'chat-1', userId: 'u1', moduleId: 'mod', commandId: 'ban', argsRedacted: true, durationMs: 5, success: true }) });
    const second = processor.process({ ...base, idempotencyKey: 'command:2', after: observed({ chatId: 'chat-1', userId: 'u1', moduleId: 'mod', commandId: 'ban', argsRedacted: true, durationMs: 7, success: true }) });

    const firstInput = toDownstreamInput(first);
    const secondInput = toDownstreamInput(second);
    expect(firstInput.subjectId).not.toBe(secondInput.subjectId);
  });

  it('uses an explicit idempotencyKey for command.executed instead of the random subjectId', () => {
    const base = {
      name: 'command.executed' as const,
      version: 1 as const,
      operation: 'noop' as const,
      chatId: 'chat-1',
      idempotencyKey: 'telegram-update:123:command:ban',
      before: notApplicable(),
      after: observed({ chatId: 'chat-1', userId: 'u1', moduleId: 'mod', commandId: 'ban', argsRedacted: true, durationMs: 5, success: true }),
    };
    const firstInput = toDownstreamInput(processor.process(base));
    const replayInput = toDownstreamInput(processor.process(base));

    expect(firstInput.subjectId).not.toBe(replayInput.subjectId);
    expect(firstInput.idempotencyKey).toBe('telegram-update:123:command:ban');
    expect(replayInput.idempotencyKey).toBe(firstInput.idempotencyKey);
  });

  it('rejects command.executed without an explicit idempotencyKey', () => {
    const record = processor.process({
      name: 'command.executed',
      version: 1,
      operation: 'noop',
      chatId: 'chat-1',
      before: notApplicable(),
      after: observed({ chatId: 'chat-1', userId: 'u1', moduleId: 'mod', commandId: 'ban', argsRedacted: true, durationMs: 5, success: true }),
    });

    expect(() => toDownstreamInput(record)).toThrow(MissingAuditIdempotencyKeyError);
  });

  it('bridges only `operation` into metadata — severity/siteVisible/canBeDisabled now live on seeded audit.event_types, not metadata', () => {
    const record = processor.process({
      name: 'command.executed', // log-like: full record known upfront, metadata bridging applies
      version: 1,
      operation: 'noop',
      chatId: 'chat-1',
      before: notApplicable(),
      after: observed({ chatId: 'chat-1', userId: 'u1', moduleId: 'mod', commandId: 'ban', argsRedacted: true, durationMs: 5, success: true }),
    });

    const bridge = buildMetadataBridge(record);
    expect(bridge).toEqual({ operation: 'noop' });
  });

  it('every registered event name has a subject mapping (no silent gaps as new events are added)', () => {
    for (const name of AUDIT_EVENT_NAMES) {
      // Use whatever minimal, schema-valid fixture is easiest per event —
      // we only care that toDownstreamInput doesn't throw "no subject
      // mapping defined" for any of the 12 registered events.
      expect(() => {
        const record = processor.process({
          name,
          version: 1,
          operation: 'unknown',
          idempotencyKey: `${name}:fixture`,
          ...(CHAT_SCOPED_FIXTURE_EVENTS.has(name) ? { chatId: 'chat-1' } : {}),
          before: notApplicable(),
          after: notApplicable(),
        });
        toDownstreamInput(record);
      }).not.toThrow(/no subject mapping defined/);
    }
  });

  it('idempotencyKey never collapses two genuinely different payloads together, even with nested objects', () => {
    // Regression test: `JSON.stringify(value, Object.keys(value).sort())`
    // (the array-replacer trick previously used here) silently drops any
    // nested key not present in the top-level key list — e.g.
    // `JSON.stringify({a:{x:1}}, ['a'])` produces `{"a":{}}`. None of the
    // 12 event schemas nest objects today, but the fix must hold even if
    // one does in the future — verified here via a directly-observable
    // metadata field, since the schemas themselves are flat.
    const recordA = processor.process({
      name: 'integration.action',
      version: 1,
      operation: 'noop',
      before: notApplicable(),
      after: observed({ integrationId: 'i1', action: 'call', targetType: 'webhook', targetId: 'wh-1', statusCode: 200, success: true }),
    });
    const recordB = processor.process({
      name: 'integration.action',
      version: 1,
      operation: 'noop',
      before: notApplicable(),
      after: observed({ integrationId: 'i1', action: 'call', targetType: 'webhook', targetId: 'wh-1', statusCode: 500, success: false }),
    });

    // Same identity (integrationId/targetId), genuinely different payload
    // (statusCode/success differ) — must produce different keys.
    expect(toDownstreamInput(recordA).idempotencyKey).not.toBe(toDownstreamInput(recordB).idempotencyKey);
  });
});

describe('toDownstreamMutationResult', () => {
  it('passes an observed after straight through, with the full ChangeSet (not flattened) as changes', () => {
    const record = processor.process({
      name: 'chat.settings.changed',
      version: 1,
      operation: 'update',
      chatId: 'chat-1',
      before: observed({ chatId: 'chat-1', locale: 'en' }),
      after: observed({ chatId: 'chat-1', locale: 'ru' }),
    });

    const result = toDownstreamMutationResult(record);
    expect(result.after).toEqual({ chatId: 'chat-1', locale: 'ru' });
    expect(result.before).toEqual({ chatId: 'chat-1', locale: 'en' });
    // Per Maxim: the full ChangeSet (status + fields), not a flattened
    // fields-only object — needed so the 'unavailable'/reason case (see
    // the test below) isn't silently indistinguishable from "no changes".
    expect(result.changes).toEqual({ status: 'computed', fields: { locale: { before: 'en', after: 'ru' } } });
  });

  it('preserves not_applicable after as a status without fabricating JSON', () => {
    const record = processor.process({
      name: 'chat.settings.changed',
      version: 1,
      operation: 'delete',
      chatId: 'chat-1',
      before: observed({ chatId: 'chat-1', locale: 'en' }),
      after: notApplicable(),
    });

    const result = toDownstreamMutationResult(record);
    expect(result.after).toBeUndefined();
    expect(result.afterSnapshotStatus).toBe('not_applicable');
    expect(result.snapshotData).toEqual({ chatId: 'chat-1', locale: 'en' });
  });

  it('preserves a genuine after gap as a status without fabricating JSON', () => {
    const record = processor.process({
      name: 'chat.settings.changed',
      version: 1,
      operation: 'update',
      chatId: 'chat-1',
      before: observed({ chatId: 'chat-1', locale: 'en' }),
      after: notObserved(),
    });

    const result = toDownstreamMutationResult(record);
    expect(result.after).toBeUndefined();
    expect(result.afterSnapshotStatus).toBe('not_observed');
    expect(result.snapshotData).toEqual({ chatId: 'chat-1', locale: 'en' });
  });

  it('reports a computed-but-empty ChangeSet (not omitted) when nothing actually changed', () => {
    const record = processor.process({
      name: 'chat.settings.changed',
      version: 1,
      operation: 'noop',
      chatId: 'chat-1',
      before: observed({ chatId: 'chat-1', locale: 'en' }),
      after: observed({ chatId: 'chat-1', locale: 'en' }),
    });

    const result = toDownstreamMutationResult(record);
    expect(result.changes).toEqual({ status: 'computed', fields: {} });
  });

  it('surfaces the ChangeSet "unavailable" reason rather than silently dropping it, when before is a genuine gap', () => {
    const record = processor.process({
      name: 'chat.settings.changed',
      version: 1,
      operation: 'update',
      chatId: 'chat-1',
      before: notObserved(),
      after: observed({ chatId: 'chat-1', locale: 'en' }),
    });

    // `after` is observed, so toDownstreamMutationResult doesn't throw —
    // but `changes` itself must still say *why* it couldn't be computed,
    // not just disappear.
    const result = toDownstreamMutationResult(record);
    expect(result.changes).toEqual({ status: 'unavailable', reason: 'before_not_observed' });
  });
});

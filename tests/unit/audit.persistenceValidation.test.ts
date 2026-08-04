import { describe, expect, it } from 'vitest';

import { AuditSnapshotValidationError, UnregisteredAuditEventError } from '../../src/lib/audit/errors.js';
import { normalizeAuditMutationForPersistence, requireAuditPersistenceDefinition } from '../../src/lib/audit/persistenceValidation.js';

describe('audit persistence validation', () => {
  it('rejects an event that is not registered before persistence', () => {
    expect(() =>
      requireAuditPersistenceDefinition({
        eventType: 'unknown.event',
        eventVersion: 'v1',
        category: 'audit',
      }),
    ).toThrow(UnregisteredAuditEventError);
  });

  it('rejects observed snapshots that do not match the registered event schema', () => {
    const input = {
      eventType: 'module.state.changed',
      eventVersion: 'v1',
      category: 'module',
    };
    const definition = requireAuditPersistenceDefinition(input);

    expect(() =>
      normalizeAuditMutationForPersistence(
        input,
        {
          before: undefined,
          after: { enabled: true },
        },
        definition,
      ),
    ).toThrow(AuditSnapshotValidationError);
  });

  it('normalizes snapshots and changes through the event allowlist before persistence', () => {
    const input = {
      eventType: 'command.executed',
      eventVersion: 'v1',
      category: 'command',
    };
    const definition = requireAuditPersistenceDefinition(input);

    const mutation = normalizeAuditMutationForPersistence(
      input,
      {
        before: undefined,
        after: {
          chatId: 'chat-1',
          userId: 'user-1',
          moduleId: 'module-admin',
          commandId: 'modules.enable',
          argsRedacted: true,
          durationMs: 15,
          success: true,
          token: 'must-not-persist',
          unlistedField: 'must-not-persist',
        } as never,
        changes: {
          status: 'computed',
          fields: {
            success: { before: false, after: true },
            token: { before: 'old', after: 'new' },
            unlistedField: { before: 'old', after: 'new' },
          },
        },
      },
      definition,
    );

    expect(mutation.after).toEqual({
      chatId: 'chat-1',
      userId: 'user-1',
      moduleId: 'module-admin',
      commandId: 'modules.enable',
      argsRedacted: true,
      durationMs: 15,
      success: true,
    });
    expect(mutation.changes).toEqual({
      status: 'computed',
      fields: {
        success: { before: false, after: true },
      },
    });
  });

  it('preserves unavailable ChangeSet status and reason while stripping forbidden nested values', () => {
    const input = {
      eventType: 'chat.settings.changed',
      eventVersion: 'v1',
      category: 'chat',
    };
    const definition = requireAuditPersistenceDefinition(input);

    const mutation = normalizeAuditMutationForPersistence(
      input,
      {
        before: undefined,
        after: { chatId: 'chat-1', locale: 'ru' },
        changes: {
          status: 'unavailable',
          reason: 'before_not_observed',
          headers: { authorization: 'Bearer token' },
        },
      },
      definition,
    );

    expect(mutation.changes).toEqual({
      status: 'unavailable',
      reason: 'before_not_observed',
    });
  });
});

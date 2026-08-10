import { describe, expect, it } from 'vitest';

import { entitySnapshots, events, outbox } from '../../src/db/schema/audit.js';
import { AuditService, ForbiddenAuditValueError } from '../../src/lib/auditService.js';
import type { AuditPolicyResolutionRow } from '../../src/lib/audit/policyResolution.js';

describe('AuditService persistence safety', () => {
  it('sanitizes metadata and explicit Telegram context before the event insert', async () => {
    const database = fakeAuditDatabase();
    const audit = new AuditService(database.db as never);

    await audit.recordEntityChange(
      {
        tenantId: 'chat-1',
        subjectType: 'chat_module_state',
        subjectId: 'chat-1:moderation',
        eventType: 'module.state.changed',
        eventVersion: 'v1',
        category: 'module',
        source: 'unit-test',
        idempotencyKey: 'unit:audit-service:safety',
        moduleId: 'moderation',
        metadata: {
          source: 'safe-source',
          truncated: false,
          unknownLabel: 'drop-unknown-metadata',
          token: 'top-level-token',
          password: 'top-level-password',
          headers: { authorization: 'Bearer secret' },
          connectionString: 'postgres://secret',
          webhookSecret: 'webhook-secret',
        },
        telegramContext: {
          correlationId: 'correlation-1',
          updateId: 'update-1',
          chatId: 'chat-1',
          userId: 'user-1',
          messageThreadId: '42',
          rawUpdate: { token: 'raw-update-token' },
          callbackPayload: { data: 'full-callback-payload' },
          files: [{ fileUrl: 'secret-file-url' }],
          arbitrary: 'drop-arbitrary-context',
        },
      },
      async () => ({
        before: undefined,
        after: { enabled: true, source: 'override' },
        metadata: {
          operation: 'update',
          reason: {
            message: 'safe reason',
            nested: {
              password: 'nested-password',
              callbackPayload: 'nested-callback-payload',
              files: ['nested-file'],
            },
          },
        },
        snapshotData: { chatId: 'chat-1', moduleId: 'moderation', enabled: true, source: 'override' },
      }),
    );

    expect(database.captured.event?.metadata).toMatchObject({
      source: 'safe-source',
      operation: 'update',
      reason: { message: 'safe reason', nested: {} },
      truncated: false,
      moduleId: 'moderation',
      auditPolicy: expect.any(Object),
    });
    expect(database.captured.event?.metadata).not.toHaveProperty('unknownLabel');
    expect(database.captured.event?.telegramContext).toEqual({
      correlationId: 'correlation-1',
      updateId: 'update-1',
      chatId: 'chat-1',
      userId: 'user-1',
      messageThreadId: '42',
    });
    expect(database.captured.outbox?.metadata).toEqual(database.captured.event?.metadata);

    const persistedJson = JSON.stringify(database.captured.event);
    for (const forbidden of [
      'top-level-token',
      'top-level-password',
      'Bearer secret',
      'postgres://secret',
      'webhook-secret',
      'raw-update-token',
      'full-callback-payload',
      'secret-file-url',
      'nested-password',
      'nested-callback-payload',
      'nested-file',
      'drop-arbitrary-context',
      'drop-unknown-metadata',
    ]) {
      expect(persistedJson).not.toContain(forbidden);
    }
  });

  it('applies the current policy masking to allowed operational metadata', async () => {
    const database = fakeAuditDatabase({ masking: ['reason'] });
    const audit = new AuditService(database.db as never);

    await audit.recordEntityChange(
      {
        tenantId: 'chat-1',
        subjectType: 'chat_module_state',
        subjectId: 'chat-1:moderation',
        eventType: 'module.state.changed',
        eventVersion: 'v1',
        category: 'module',
        source: 'unit-test',
        idempotencyKey: 'unit:audit-service:metadata-masking',
        metadata: { reason: 'policy-sensitive-reason' },
      },
      async () => ({
        before: undefined,
        after: { enabled: true, source: 'override' },
        snapshotData: { chatId: 'chat-1', moduleId: 'moderation', enabled: true, source: 'override' },
      }),
    );

    expect(database.captured.event?.metadata).toMatchObject({ reason: '[redacted]' });
    expect(JSON.stringify(database.captured.event)).not.toContain('policy-sensitive-reason');
  });

  it('redacts forbidden values nested below allowed metadata and drops unsafe Telegram identifiers', async () => {
    const database = fakeAuditDatabase();
    const audit = new AuditService(database.db as never);

    await audit.recordEntityChange(
      {
        tenantId: 'chat-1',
        subjectType: 'chat_module_state',
        subjectId: 'chat-1:moderation',
        eventType: 'module.state.changed',
        eventVersion: 'v1',
        category: 'module',
        source: 'unit-test',
        idempotencyKey: 'unit:audit-service:secret-values',
        metadata: {
          reason: {
            database: 'postgresql://audit:password@db.example/audit',
            note: 'Bearer audit-api-token',
            webhook: 'whsec_webhook-signing-secret',
            safe: 'ordinary operational explanation',
          },
        },
        telegramContext: {
          correlationId: 'correlation-1',
          updateId: 'Bearer telegram-update-secret',
          chatId: 'chat-1',
          userId: 'password=telegram-user-secret',
          messageThreadId: '42',
        },
      },
      async () => ({
        before: undefined,
        after: { enabled: true, source: 'override' },
        snapshotData: { chatId: 'chat-1', moduleId: 'moderation', enabled: true, source: 'override' },
      }),
    );

    expect(database.captured.event?.metadata).toMatchObject({
      reason: {
        database: '[redacted]',
        note: '[redacted]',
        webhook: '[redacted]',
        safe: 'ordinary operational explanation',
      },
    });
    expect(database.captured.event?.telegramContext).toEqual({
      correlationId: 'correlation-1',
      chatId: 'chat-1',
      messageThreadId: '42',
    });
    expect(JSON.stringify(database.captured.event)).not.toMatch(
      /postgresql:\/\/audit|audit-api-token|webhook-signing-secret|telegram-update-secret|telegram-user-secret/,
    );
  });

  it.each([
    ['source', { source: 'postgresql://audit:password@db.example/audit' }],
    ['actorId', { actorId: 'Bearer actor-access-token' }],
    ['subjectId', { subjectId: 'whsec_subject-webhook-secret' }],
    ['correlationId', { correlationId: 'password=correlation-secret' }],
    ['idempotencyKey', { idempotencyKey: 'Bearer idempotency-secret' }],
  ] as const)('rejects a forbidden value in the %s event envelope field before mutation', async (_field, override) => {
    const database = fakeAuditDatabase();
    const audit = new AuditService(database.db as never);
    let mutationCalled = false;

    await expect(
      audit.recordEntityChange(
        {
          tenantId: 'chat-1',
          subjectType: 'chat_module_state',
          subjectId: 'chat-1:moderation',
          eventType: 'module.state.changed',
          eventVersion: 'v1',
          category: 'module',
          source: 'unit-test',
          idempotencyKey: 'unit:audit-service:unsafe-envelope',
          ...override,
        },
        async () => {
          mutationCalled = true;
          return {
            before: undefined,
            after: { enabled: true, source: 'override' },
            snapshotData: { chatId: 'chat-1', moduleId: 'moderation', enabled: true, source: 'override' },
          };
        },
      ),
    ).rejects.toThrow(ForbiddenAuditValueError);

    expect(mutationCalled).toBe(false);
    expect(database.captured.event).toBeUndefined();
  });
});

function fakeAuditDatabase(policyOverrides: Partial<AuditPolicyResolutionRow> = {}) {
  const captured: { event?: Record<string, unknown>; outbox?: Record<string, unknown> } = {};
  const enabledPolicy: AuditPolicyResolutionRow = {
    policyId: 'unit:enabled-policy',
    chatId: 'chat-1',
    eventType: 'module.state.changed',
    eventVersion: 'v1',
    moduleId: null,
    enabled: true,
    siteVisible: null,
    snapshotMode: null,
    allowlist: null,
    masking: null,
    retentionDays: null,
    severity: null,
    exportAllowed: null,
    ...policyOverrides,
  };
  const transaction = {
    select(selection: Record<string, unknown>) {
      if ('policyId' in selection) return { from: async () => [enabledPolicy] };
      if ('lastSubjectSequence' in selection) {
        const query = {
          from: () => query,
          where: () => query,
          limit: () => query,
          for: async () => [{ lastSubjectSequence: 0 }],
        };
        return query;
      }
      const query = {
        from: () => query,
        where: () => query,
        limit: async () => [],
      };
      return query;
    },
    insert(table: unknown) {
      if (table === entitySnapshots) {
        return { values: () => ({ onConflictDoNothing: async () => undefined }) };
      }
      if (table === events) {
        return {
          values: (value: Record<string, unknown>) => {
            captured.event = value;
            return {
              returning: async () => [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subjectSequence: 1 }],
            };
          },
        };
      }
      if (table === outbox) {
        return {
          values: async (value: { readonly payload?: Record<string, unknown> }) => {
            if (value.payload !== undefined) captured.outbox = value.payload;
          },
        };
      }
      throw new Error('Unexpected table in AuditService safety test');
    },
    update() {
      const query = { set: () => query, where: async () => undefined };
      return query;
    },
  };

  return {
    captured,
    db: { transaction: async (operation: (tx: typeof transaction) => Promise<unknown>) => operation(transaction) },
  };
}

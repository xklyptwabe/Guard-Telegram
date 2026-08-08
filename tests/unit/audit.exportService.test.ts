import { describe, expect, it } from 'vitest';

import {
  AuditExportPolicyError,
  createAuditExport,
} from '../../src/lib/audit/exportService.js';
import type { AuditEventReadRow } from '../../src/lib/audit/eventReadRepository.js';
import type { AuditPolicyResolutionRow } from '../../src/lib/audit/policyResolution.js';
import type { AuditService } from '../../src/lib/auditService.js';

describe('audit export service', () => {
  it('exports rows and records audit.exported', async () => {
    const rows = [eventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')];
    const db = fakeExportDb({
      events: rows,
      policies: [policyRow({ exportAllowed: true, enabled: true })],
    });
    const audit = fakeAuditService();

    const result = await createAuditExport(db as never, audit as unknown as AuditService, {
      scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
      filters: { chatIds: ['chat-1'], eventTypes: ['message.deleted'] },
      format: 'json',
      requestedBy: 'operator-1',
      limit: 10,
    });

    expect(result).toMatchObject({
      format: 'json',
      rowCount: 1,
      truncated: false,
      auditEventId: 'audit-event-1',
    });
    expect(result.data).toEqual([
      expect.objectContaining({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        occurredAt: '2026-08-07T10:00:00.000Z',
      }),
    ]);
    expect(audit.calls.input).toMatchObject({
      tenantId: '__platform__',
      subjectType: 'audit_export',
      eventType: 'audit.exported',
      actorId: 'operator-1',
      source: 'backend.api.audit.export',
    });
    expect(audit.calls.mutation).toMatchObject({
      after: {
        requestedBy: 'operator-1',
        format: 'json',
        rangeFrom: '2026-08-07T10:00:00.000Z',
        rangeTo: '2026-08-07T10:00:00.000Z',
        rowCount: 1,
      },
      snapshotData: {
        requestedBy: 'operator-1',
        format: 'json',
        rowCount: 1,
      },
    });
  });

  it('formats csv exports', async () => {
    const audit = fakeAuditService();
    const result = await createAuditExport(
      fakeExportDb({
        events: [eventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
        policies: [policyRow({ exportAllowed: true, enabled: true })],
      }) as never,
      audit as unknown as AuditService,
      {
        scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
        filters: {},
        format: 'csv',
        requestedBy: 'operator-1',
      },
    );

    expect(result.contentType).toBe('text/csv; charset=utf-8');
    expect(result.data).toContain('id,eventType,eventVersion');
    expect(result.data).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa,message.deleted,v1');
  });

  it('reapplies the current effective allowlist and masking to historical JSON rows', async () => {
    const audit = fakeAuditService();
    const result = await createAuditExport(
      fakeExportDb({
        events: [historicalEventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
        policies: [
          policyRow({
            enabled: true,
            exportAllowed: true,
            allowlist: ['chatId', 'messageId', 'deletedBy'],
            masking: ['deletedBy', 'policySensitive'],
          }),
        ],
      }) as never,
      audit as unknown as AuditService,
      {
        scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
        filters: {},
        format: 'json',
        requestedBy: 'operator-1',
      },
    );

    expect(result.data).toEqual([
      expect.objectContaining({
        before: {
          chatId: 'chat-1',
          messageId: 'message-1',
          deletedBy: '[redacted]',
        },
        after: {
          chatId: 'chat-1',
          messageId: 'message-1',
          deletedBy: '[redacted]',
        },
        changes: {
          status: 'updated',
          fields: {
            deletedBy: { before: '[redacted]', after: '[redacted]' },
          },
        },
        metadata: {
          moduleId: 'moderation',
          deletedBy: '[redacted]',
          policySensitive: '[redacted]',
        },
      }),
    ]);
    expect(JSON.stringify(result.data)).not.toContain('historical-sensitive-value');
    expect(JSON.stringify(result.data)).not.toContain('historical message text');
    expect(JSON.stringify(result.data)).not.toContain('historical-secret-token');
    expect(JSON.stringify(result.data)).not.toContain('historical-policy-sensitive');
  });

  it('reapplies the current effective allowlist and masking before CSV serialization', async () => {
    const audit = fakeAuditService();
    const result = await createAuditExport(
      fakeExportDb({
        events: [historicalEventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
        policies: [
          policyRow({
            enabled: true,
            exportAllowed: true,
            allowlist: ['chatId', 'messageId', 'deletedBy'],
            masking: ['deletedBy', 'policySensitive'],
          }),
        ],
      }) as never,
      audit as unknown as AuditService,
      {
        scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
        filters: {},
        format: 'csv',
        requestedBy: 'operator-1',
      },
    );

    expect(result.data).toContain('[redacted]');
    expect(result.data).not.toContain('historical-sensitive-value');
    expect(result.data).not.toContain('historical message text');
    expect(result.data).not.toContain('historical-secret-token');
    expect(result.data).not.toContain('historical-policy-sensitive');
  });

  it('applies each row policy using its own tenant context', async () => {
    const audit = fakeAuditService();
    const result = await createAuditExport(
      fakeExportDb({
        events: [
          historicalEventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'chat-1'),
          historicalEventRow('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'chat-2'),
        ],
        policies: [
          policyRow({
            policyId: 'chat:chat-1:event:message.deleted:v1',
            chatId: 'chat-1',
            enabled: true,
            exportAllowed: true,
            allowlist: ['chatId', 'messageId', 'deletedBy'],
            masking: ['deletedBy'],
          }),
          policyRow({
            policyId: 'chat:chat-2:event:message.deleted:v1',
            chatId: 'chat-2',
            enabled: true,
            exportAllowed: true,
            allowlist: ['chatId', 'messageId', 'userId', 'deletedBy'],
            masking: ['userId'],
          }),
        ],
      }) as never,
      audit as unknown as AuditService,
      {
        scope: { systemAdmin: false, allowedChatIds: ['chat-1', 'chat-2'] },
        filters: {},
        format: 'json',
        requestedBy: 'operator-1',
      },
    );

    expect(result.data).toEqual([
      expect.objectContaining({
        tenantId: 'chat-1',
        after: {
          chatId: 'chat-1',
          messageId: 'message-1',
          deletedBy: '[redacted]',
        },
      }),
      expect.objectContaining({
        tenantId: 'chat-2',
        after: {
          chatId: 'chat-2',
          messageId: 'message-1',
          userId: '[redacted]',
          deletedBy: 'historical-sensitive-value',
        },
      }),
    ]);
  });

  it('fails closed when export policy is not enabled for a row', async () => {
    const audit = fakeAuditService();

    await expect(
      createAuditExport(
        fakeExportDb({
          events: [eventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
          policies: [policyRow({ exportAllowed: false, enabled: true })],
        }) as never,
        audit as unknown as AuditService,
        {
          scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
          filters: {},
          format: 'json',
          requestedBy: 'operator-1',
        },
      ),
    ).rejects.toThrow(AuditExportPolicyError);

    expect(audit.calls.input).toBeUndefined();
  });

  it('fails closed when metadata and snapshots disagree about the module', async () => {
    const audit = fakeAuditService();
    const event = eventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    await expect(
      createAuditExport(
        fakeExportDb({
          events: [{ ...event, before: { moduleId: 'canonical-module' }, metadata: { moduleId: 'other-module' } }],
          policies: [policyRow({ exportAllowed: true, enabled: true })],
        }) as never,
        audit as unknown as AuditService,
        {
          scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
          filters: {},
          format: 'json',
          requestedBy: 'operator-1',
        },
      ),
    ).rejects.toThrow(AuditExportPolicyError);

    expect(audit.calls.input).toBeUndefined();
  });

  it('applies the module export policy to the canonical event module', async () => {
    const audit = fakeAuditService();

    await expect(
      createAuditExport(
        fakeExportDb({
          events: [eventRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')],
          policies: [
            policyRow({
              policyId: 'global',
              chatId: null,
              eventType: null,
              eventVersion: null,
              moduleId: null,
              exportAllowed: true,
              enabled: true,
            }),
            policyRow({
              policyId: 'chat:chat-1:module:moderation',
              eventType: null,
              eventVersion: null,
              moduleId: 'moderation',
              exportAllowed: false,
              enabled: true,
            }),
          ],
        }) as never,
        audit as unknown as AuditService,
        {
          scope: { systemAdmin: false, allowedChatIds: ['chat-1'] },
          filters: {},
          format: 'json',
          requestedBy: 'operator-1',
        },
      ),
    ).rejects.toThrow(AuditExportPolicyError);

    expect(audit.calls.input).toBeUndefined();
  });
});

function fakeExportDb(options: {
  readonly events: readonly AuditEventReadRow[];
  readonly policies: readonly AuditPolicyResolutionRow[];
}) {
  return {
    select(selection: Record<string, unknown>) {
      if ('policyId' in selection) {
        return { from: async () => options.policies };
      }
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async (limit: number) => options.events.slice(0, limit),
      };
      return query;
    },
  };
}

function fakeAuditService() {
  const calls: { input?: unknown; mutation?: unknown } = {};
  return {
    calls,
    recordEntityChange: async (input: unknown, mutate: () => Promise<unknown>) => {
      calls.input = input;
      calls.mutation = await mutate();
      return { eventId: 'audit-event-1', subjectSequence: 1, duplicate: false };
    },
  };
}

function eventRow(id: string, tenantId = 'chat-1'): AuditEventReadRow {
  const occurredAt = new Date('2026-08-07T10:00:00.000Z');
  return {
    id,
    eventType: 'message.deleted',
    eventVersion: 'v1',
    category: 'message',
    occurredAt,
    recordedAt: occurredAt,
    source: 'telegram.command',
    status: 'recorded',
    tenantId,
    actorId: 'operator-1',
    actorType: 'telegram_user',
    subjectType: 'message',
    subjectId: `${tenantId}:message-1`,
    subjectSequence: 1,
    correlationId: 'corr-1',
    telegramContext: { chatId: tenantId },
    before: null,
    after: null,
    beforeSnapshotStatus: 'not_observed',
    afterSnapshotStatus: 'observed',
    changes: null,
    metadata: { moduleId: 'moderation' },
  };
}

function historicalEventRow(id: string, tenantId = 'chat-1'): AuditEventReadRow {
  return {
    ...eventRow(id, tenantId),
    before: {
      chatId: tenantId,
      messageId: 'message-1',
      userId: 'historical-user',
      deletedBy: 'historical-sensitive-value',
      text: 'historical message text',
    },
    after: {
      chatId: tenantId,
      messageId: 'message-1',
      userId: 'historical-user',
      deletedBy: 'historical-sensitive-value',
      text: 'historical message text',
    },
    changes: {
      status: 'updated',
      fields: {
        userId: { before: 'historical-user', after: 'historical-user' },
        deletedBy: { before: 'historical-sensitive-value', after: 'historical-sensitive-value' },
        text: { before: 'historical message text', after: 'historical message text' },
      },
    },
    metadata: {
      moduleId: 'moderation',
      deletedBy: 'historical-sensitive-value',
      policySensitive: 'historical-policy-sensitive',
      secretToken: 'historical-secret-token',
    },
    beforeSnapshotStatus: 'observed',
    afterSnapshotStatus: 'observed',
  };
}

function policyRow(values: Partial<AuditPolicyResolutionRow>): AuditPolicyResolutionRow {
  return {
    policyId: 'chat:chat-1:event:message.deleted:v1',
    chatId: 'chat-1',
    eventType: 'message.deleted',
    eventVersion: 'v1',
    moduleId: null,
    enabled: null,
    siteVisible: null,
    snapshotMode: null,
    allowlist: null,
    masking: null,
    retentionDays: null,
    severity: null,
    exportAllowed: null,
    ...values,
  };
}

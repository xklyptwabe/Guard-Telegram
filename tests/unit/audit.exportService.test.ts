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

function eventRow(id: string): AuditEventReadRow {
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
    tenantId: 'chat-1',
    actorId: 'operator-1',
    actorType: 'telegram_user',
    subjectType: 'message',
    subjectId: 'chat-1:message-1',
    subjectSequence: 1,
    correlationId: 'corr-1',
    telegramContext: { chatId: 'chat-1' },
    before: null,
    after: null,
    beforeSnapshotStatus: 'not_observed',
    afterSnapshotStatus: 'observed',
    changes: null,
    metadata: { moduleId: 'moderation' },
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

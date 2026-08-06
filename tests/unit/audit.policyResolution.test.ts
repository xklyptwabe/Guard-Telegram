import { describe, expect, it } from 'vitest';

import {
  resolveEffectiveAuditPolicy,
  resolveEffectiveAuditPolicyFromRows,
  type AuditPolicyResolutionRow,
} from '../../src/lib/audit/policyResolution.js';

const target = {
  chatId: 'chat-1',
  eventType: 'message.deleted',
  eventVersion: 'v1',
  moduleId: 'moderation',
} as const;

describe('audit policy resolution', () => {
  it('resolves effective values from the highest-priority row that defines each parameter', () => {
    const policy = resolveEffectiveAuditPolicyFromRows(
      [
        row('global', { retentionDays: 365, severity: 'info', exportAllowed: false }),
        row('global-module', { moduleId: 'moderation', severity: 'warning' }),
        row('global-event', { eventType: 'message.deleted', eventVersion: 'v1', siteVisible: true }),
        row('chat', { chatId: 'chat-1', retentionDays: 30 }),
        row('chat-module', { chatId: 'chat-1', moduleId: 'moderation', snapshotMode: 'metadata' }),
        row('chat-event', {
          chatId: 'chat-1',
          eventType: 'message.deleted',
          eventVersion: 'v1',
          enabled: true,
          allowlist: ['chatId', 'messageId'],
          masking: ['reason'],
        }),
      ],
      target,
    );

    expect(policy.values).toMatchObject({
      enabled: true,
      siteVisible: true,
      snapshotMode: 'metadata',
      allowlist: ['chatId', 'messageId'],
      masking: ['reason'],
      retentionDays: 30,
      severity: 'warning',
      exportAllowed: false,
    });
    expect(policy.sources.enabled).toMatchObject({ policyId: 'chat-event', priority: 'chat_event_type' });
    expect(policy.sources.snapshotMode).toMatchObject({ policyId: 'chat-module', priority: 'chat_module' });
    expect(policy.sources.retentionDays).toMatchObject({ policyId: 'chat', priority: 'chat' });
    expect(policy.sources.severity).toMatchObject({ policyId: 'global-module', priority: 'global_module' });
  });

  it('reads rows on every call so policy changes are visible without recreating the resolver', async () => {
    let rows: readonly AuditPolicyResolutionRow[] = [
      row('global-event', { eventType: 'message.deleted', eventVersion: 'v1', enabled: true }),
    ];
    const db = {
      select: () => ({
        from: async () => rows,
      }),
    };

    await expect(resolveEffectiveAuditPolicy(db as never, target)).resolves.toMatchObject({
      values: { enabled: true },
    });

    rows = [row('global-event', { eventType: 'message.deleted', eventVersion: 'v1', enabled: false })];

    await expect(resolveEffectiveAuditPolicy(db as never, target)).resolves.toMatchObject({
      values: { enabled: false },
    });
  });
});

function row(policyId: string, values: Partial<AuditPolicyResolutionRow>): AuditPolicyResolutionRow {
  return {
    policyId,
    chatId: null,
    eventType: null,
    eventVersion: null,
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

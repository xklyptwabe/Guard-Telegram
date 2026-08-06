import { describe, expect, it } from 'vitest';

import { AuditEventProcessor } from '../../src/lib/audit/eventProcessor.js';
import { notApplicable, observed } from '../../src/lib/audit/snapshot.js';

const processor = new AuditEventProcessor();

describe('audit policy parameters', () => {
  it('allows audit.policy.changed snapshots to carry every BOTS-8 policy parameter', () => {
    const record = processor.process({
      name: 'audit.policy.changed',
      version: 1,
      operation: 'update',
      before: notApplicable(),
      after: observed({
        policyId: 'global:event:message.deleted:v1',
        scope: 'global',
        targetType: 'event_type',
        eventType: 'message.deleted',
        eventVersion: 'v1',
        enabled: false,
        siteVisible: false,
        snapshotMode: 'metadata',
        allowlist: ['chatId', 'messageId', 'userId'],
        masking: ['reason'],
        retentionDays: 90,
        severity: 'warning',
        exportAllowed: false,
        lockVersion: 2,
      }),
    });

    expect(record.after).toEqual({
      status: 'observed',
      data: {
        policyId: 'global:event:message.deleted:v1',
        scope: 'global',
        targetType: 'event_type',
        eventType: 'message.deleted',
        eventVersion: 'v1',
        enabled: false,
        siteVisible: false,
        snapshotMode: 'metadata',
        allowlist: ['chatId', 'messageId', 'userId'],
        masking: ['reason'],
        retentionDays: 90,
        severity: 'warning',
        exportAllowed: false,
        lockVersion: 2,
      },
    });
  });
});

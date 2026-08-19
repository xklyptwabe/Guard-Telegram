import { describe, expect, it, vi } from 'vitest';

import { recordIntegrationAction } from '../../src/lib/audit/integrationAudit.js';
import { AuditPolicyDisabledError, type AuditService } from '../../src/lib/auditService.js';
import type { Logger } from '../../src/lib/logger.js';

function fakeAuditService(options: { throwOnRecord?: boolean; policyDisabled?: boolean } = {}) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: () => Promise<unknown>) => {
      if (options.policyDisabled) throw new AuditPolicyDisabledError('integration.action', 'v1');
      if (options.throwOnRecord) throw new Error('simulated audit failure');
      const result = await mutate();
      calls.push({ input, result });
      return { eventId: 'evt-1', subjectSequence: 1, duplicate: false };
    }),
  } as unknown as AuditService;
  return { audit, calls };
}

function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('recordIntegrationAction', () => {
  it('records a successful integration call with all fields, outcome first-class', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, {
      integrationId: 'rabbitmq',
      action: 'send_reminder',
      targetType: 'queue',
      targetId: 'guard.telegram.actions',
      outcome: 'succeeded',
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { result: { after: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({
      integrationId: 'rabbitmq',
      action: 'send_reminder',
      targetType: 'queue',
      targetId: 'guard.telegram.actions',
      outcome: 'succeeded',
      success: true,
    });
    expect(await recordIntegrationAction(audit, logger, { integrationId: 'r', action: 'a', targetType: 't', targetId: 'i', outcome: 'succeeded' })).toEqual({ status: 'recorded' });
  });

  it('BOTS-9 round-2 HIGH-2: failed and unknown stay distinguishable — NOT collapsed into success:false', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, {
      integrationId: 's3',
      action: 'put',
      targetType: 'object',
      targetId: 'exports/2026-08.csv',
      outcome: 'failed',
    });
    await recordIntegrationAction(audit, logger, {
      integrationId: 's3',
      action: 'put',
      targetType: 'object',
      targetId: 'exports/2026-08.csv',
      outcome: 'unknown',
    });

    const failed = calls[0] as { result: { after: Record<string, unknown> } };
    const unknown = calls[1] as { result: { after: Record<string, unknown> } };
    expect(failed.result.after).toMatchObject({ outcome: 'failed', success: false });
    expect(unknown.result.after).toMatchObject({ outcome: 'unknown', success: false });
    expect(failed.result.after.outcome).not.toBe(unknown.result.after.outcome);
  });

  it('includes statusCode only when provided (never fabricates one)', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'k', statusCode: 200, outcome: 'succeeded' });
    await recordIntegrationAction(audit, logger, { integrationId: 'rabbitmq', action: 'publish', targetType: 'queue', targetId: 'q', outcome: 'succeeded' });

    const withStatus = calls[0] as { result: { after: Record<string, unknown> } };
    const withoutStatus = calls[1] as { result: { after: Record<string, unknown> } };
    expect(withStatus.result.after.statusCode).toBe(200);
    expect('statusCode' in withoutStatus.result.after).toBe(false);
  });

  it('generates a distinct idempotencyKey per call — no accidental dedup of two intentionally identical calls', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    const params = { integrationId: 'rabbitmq', action: 'ping', targetType: 'queue', targetId: 'q', outcome: 'succeeded' } as const;
    await recordIntegrationAction(audit, logger, params);
    await recordIntegrationAction(audit, logger, params);

    expect(calls).toHaveLength(2);
    const first = calls[0] as { input: { idempotencyKey: string } };
    const second = calls[1] as { input: { idempotencyKey: string } };
    expect(first.input.idempotencyKey).not.toBe(second.input.idempotencyKey);
  });

  it('BOTS-9 round-2 BLOCKER-1: an infrastructure audit failure THROWS (outbox keeps audit_status=pending) instead of being swallowed', async () => {
    const { audit } = fakeAuditService({ throwOnRecord: true });
    const logger = fakeLogger();

    await expect(recordIntegrationAction(audit, logger, { integrationId: 'rabbitmq', action: 'publish', targetType: 'queue', targetId: 'q', outcome: 'succeeded' })).rejects.toThrow('simulated audit failure');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.integration_action.failed' }));
  });

  it('BOTS-9 round-2 BLOCKER-1: a policy-disabled event maps to {status:"policy_skipped"} — nothing owed, backfill stops', async () => {
    const { audit } = fakeAuditService({ policyDisabled: true });
    const logger = fakeLogger();

    await expect(recordIntegrationAction(audit, logger, { integrationId: 'rabbitmq', action: 'publish', targetType: 'queue', targetId: 'q', outcome: 'succeeded' })).resolves.toEqual({ status: 'policy_skipped' });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.integration_action.policy_skipped' }));
  });

  it('BOTS-9 review HIGH-7: without chatId, tenantId is the platform-wide sentinel — unchanged, current behavior for every existing caller', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'k', outcome: 'succeeded' });

    const call = calls[0] as { input: { tenantId: string } };
    expect(call.input.tenantId).toBe('__platform__');
  });

  it('BOTS-9 review HIGH-7: a caller that DOES have chat context gets tenantId = that chat, enabling chat-scoped policy resolution instead of only the platform-wide one', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'k', outcome: 'succeeded', chatId: '-100555' });

    const call = calls[0] as { input: { tenantId: string } };
    expect(call.input.tenantId).toBe('-100555');
  });
});

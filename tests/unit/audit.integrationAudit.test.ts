import { describe, expect, it, vi } from 'vitest';

import { recordIntegrationAction } from '../../src/lib/audit/integrationAudit.js';
import type { AuditService } from '../../src/lib/auditService.js';
import type { Logger } from '../../src/lib/logger.js';

function fakeAuditService(options: { throwOnRecord?: boolean } = {}) {
  const calls: Array<{ input: unknown; result: unknown }> = [];
  const audit = {
    recordEntityChange: vi.fn(async (input: unknown, mutate: () => Promise<unknown>) => {
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
  it('records a successful integration call with all fields', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, {
      integrationId: 'rabbitmq',
      action: 'send_reminder',
      targetType: 'queue',
      targetId: 'guard.telegram.actions',
      success: true,
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { result: { after: Record<string, unknown> } };
    expect(call.result.after).toMatchObject({
      integrationId: 'rabbitmq',
      action: 'send_reminder',
      targetType: 'queue',
      targetId: 'guard.telegram.actions',
      success: true,
    });
  });

  it('records a failed integration call with success:false', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, {
      integrationId: 's3',
      action: 'put',
      targetType: 'object',
      targetId: 'exports/2026-08.csv',
      success: false,
    });

    const call = calls[0] as { result: { after: Record<string, unknown> } };
    expect(call.result.after.success).toBe(false);
  });

  it('includes statusCode only when provided (never fabricates one)', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    await recordIntegrationAction(audit, logger, { integrationId: 's3', action: 'put', targetType: 'object', targetId: 'k', statusCode: 200, success: true });
    await recordIntegrationAction(audit, logger, { integrationId: 'rabbitmq', action: 'publish', targetType: 'queue', targetId: 'q', success: true });

    const withStatus = calls[0] as { result: { after: Record<string, unknown> } };
    const withoutStatus = calls[1] as { result: { after: Record<string, unknown> } };
    expect(withStatus.result.after.statusCode).toBe(200);
    expect('statusCode' in withoutStatus.result.after).toBe(false);
  });

  it('generates a distinct idempotencyKey per call — no accidental dedup of two intentionally identical calls', async () => {
    const { audit, calls } = fakeAuditService();
    const logger = fakeLogger();

    const params = { integrationId: 'rabbitmq', action: 'ping', targetType: 'queue', targetId: 'q', success: true } as const;
    await recordIntegrationAction(audit, logger, params);
    await recordIntegrationAction(audit, logger, params);

    expect(calls).toHaveLength(2);
    const first = calls[0] as { input: { idempotencyKey: string } };
    const second = calls[1] as { input: { idempotencyKey: string } };
    expect(first.input.idempotencyKey).not.toBe(second.input.idempotencyKey);
  });

  it('never throws — swallows an audit-layer failure and logs it instead', async () => {
    const { audit } = fakeAuditService({ throwOnRecord: true });
    const logger = fakeLogger();

    await expect(
      recordIntegrationAction(audit, logger, { integrationId: 'rabbitmq', action: 'publish', targetType: 'queue', targetId: 'q', success: true }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.integration_action.failed' }));
  });
});

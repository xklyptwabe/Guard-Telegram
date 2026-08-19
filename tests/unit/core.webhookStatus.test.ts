import { BotError, type Context } from 'grammy';
import { describe, expect, it } from 'vitest';

import { AuditFinalizationPendingError } from '../../src/lib/moderation/pendingOperationsOutbox.js';
import { UpdateBusyError, webhookStatusForError, unwrapMiddlewareError } from '../../src/core/updates.js';

function wrap(error: Error): BotError {
  return new BotError(error, { update: { update_id: 1 } } as Context);
}

describe('webhookStatusForError (round-4)', () => {
  it('unwraps grammY BotError so busy is 409, not 400', () => {
    expect(webhookStatusForError(wrap(new UpdateBusyError('1', 'lease_held')))).toBe(409);
    expect(webhookStatusForError(new UpdateBusyError('1', 'backoff'))).toBe(409);
  });

  it('maps audit-pending (plain and wrapped) to 503', () => {
    expect(webhookStatusForError(wrap(new AuditFinalizationPendingError('owed')))).toBe(503);
    expect(webhookStatusForError(new AuditFinalizationPendingError('owed'))).toBe(503);
  });

  it('maps unknown failures to 400', () => {
    expect(webhookStatusForError(wrap(new Error('parse')))).toBe(400);
    expect(webhookStatusForError(new Error('parse'))).toBe(400);
  });

  it('unwrapMiddlewareError peels BotError', () => {
    const inner = new UpdateBusyError('9', 'lease_held');
    expect(unwrapMiddlewareError(wrap(inner))).toBe(inner);
  });
});

import { BotError, type Context } from 'grammy';
import { describe, expect, it } from 'vitest';

import { AuditFinalizationPendingError } from '../../src/lib/moderation/pendingOperationsOutbox.js';
import { CommandAuditPendingError } from '../../src/core/dispatcher.js';
import { UpdateBusyError, UpdateExhaustedError, webhookStatusForError, unwrapMiddlewareError } from '../../src/core/updates.js';
import { z } from 'zod';

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

  it('maps subclass audit-pending names to 503', () => {
    expect(webhookStatusForError(wrap(new CommandAuditPendingError('ban', new Error('db'))))).toBe(503);
  });

  it('maps exhausted inbox to 503 (do not confirm 200)', () => {
    expect(webhookStatusForError(new UpdateExhaustedError('1'))).toBe(503);
  });

  it('maps client parse failures to 400 and infra to 503', () => {
    expect(webhookStatusForError(new SyntaxError('bad json'))).toBe(400);
    expect(webhookStatusForError(new z.ZodError([]))).toBe(400);
    expect(webhookStatusForError(wrap(new Error('db down')))).toBe(503);
  });

  it('unwrapMiddlewareError peels BotError', () => {
    const inner = new UpdateBusyError('9', 'lease_held');
    expect(unwrapMiddlewareError(wrap(inner))).toBe(inner);
  });
});

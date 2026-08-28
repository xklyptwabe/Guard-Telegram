import { describe, expect, it } from 'vitest';

import { AuditSnapshotValidationError, UnregisteredAuditEventError, UnsupportedAuditEventVersionError } from '../../src/lib/audit/errors.js';
import { AuditEventProcessor } from '../../src/lib/audit/eventProcessor.js';
import { notApplicable, observed } from '../../src/lib/audit/snapshot.js';

const processor = new AuditEventProcessor();

describe('AuditEventProcessor.process', () => {
  it('rejects an unregistered event name before touching any snapshot', () => {
    expect(() =>
      processor.process({
        // @ts-expect-error deliberately not a registered event name
        name: 'totally.made.up',
        version: 1,
        operation: 'update',
        before: notApplicable(),
        after: notApplicable(),
      }),
    ).toThrow(UnregisteredAuditEventError);
  });

  it('rejects an unsupported event version', () => {
    expect(() =>
      processor.process({
        name: 'module.state.changed',
        version: 7,
        operation: 'update',
        before: notApplicable(),
        after: observed({ chatId: '1', moduleId: 'welcome', enabled: true }),
      }),
    ).toThrow(UnsupportedAuditEventVersionError);
  });

  it('rejects a snapshot that fails the event schema', () => {
    expect(() =>
      processor.process({
        name: 'chat.settings.changed',
        version: 1,
        operation: 'update',
        before: observed({ chatId: '1', locale: 'en' }),
        // `locale` missing entirely — chat.settings.changed is not sparse.
        after: observed({ chatId: '1' }),
      }),
    ).toThrow(AuditSnapshotValidationError);
  });

  it('accepts a sparse module.state.changed snapshot when effective value and source are present', () => {
    const record = processor.process({
      name: 'module.state.changed',
      operation: 'update',
      version: 1,
      chatId: 'chat-1',
      actorId: 'admin-1',
      before: observed({ enabled: false, source: 'default' }),
      after: observed({ enabled: true, source: 'override' }),
    });

    expect(record.before).toEqual({ status: 'observed', data: { enabled: false, source: 'default' } });
    expect(record.after).toEqual({ status: 'observed', data: { enabled: true, source: 'override' } });
    expect(record.changes).toEqual({
      status: 'computed',
      fields: {
        enabled: { before: false, after: true },
        source: { before: 'default', after: 'override' },
      },
    });
  });

  it('rejects a sparse module.state.changed snapshot without source', () => {
    expect(() =>
      processor.process({
        name: 'module.state.changed',
        operation: 'update',
        version: 1,
        chatId: 'chat-1',
        before: observed({ enabled: false }),
        after: observed({ enabled: true }),
      }),
    ).toThrow(AuditSnapshotValidationError);
  });

  it('never lets forbidden fields reach the resulting record, even if smuggled into a valid snapshot', () => {
    const record = processor.process({
      name: 'command.executed',
      version: 1,
      operation: 'create',
      before: notApplicable(),
      after: observed({
        chatId: '1',
        userId: '2',
        moduleId: 'poll',
        commandId: 'create_poll',
        argsRedacted: true,
        durationMs: 12,
        success: true,
        // Not part of the schema, but if some caller ever smuggled it through
        // an untyped boundary, masking must still remove it.
        webhookSecret: 'sh',
      } as never),
    });

    expect(record.after.status).toBe('observed');
    if (record.after.status === 'observed') {
      expect(record.after.data).not.toHaveProperty('webhookSecret');
      expect(record.after.data).toEqual({
        chatId: '1',
        userId: '2',
        moduleId: 'poll',
        commandId: 'create_poll',
        argsRedacted: true,
        durationMs: 12,
        success: true,
      });
    }
  });

  it('does not replace a not_observed "before" with an empty object', () => {
    const record = processor.process({
      name: 'bot.membership.changed',
      version: 1,
      operation: 'unknown',
      before: { status: 'not_observed' },
      after: observed({ chatId: '1', botId: '42', status: 'left' }),
    });

    expect(record.before).toEqual({ status: 'not_observed' });
    expect(record.before).not.toHaveProperty('data');
    expect(record.changes).toEqual({ status: 'unavailable', reason: 'before_not_observed' });
  });

  it('carries the effective value and its default/override source for module.state.changed', () => {
    const record = processor.process({
      name: 'module.state.changed',
      version: 1,
      operation: 'update',
      chatId: 'chat-1',
      actorId: 'admin-1',
      before: observed({ enabled: false, source: 'default' }),
      after: observed({ enabled: true, source: 'override' }),
    });

    expect(record.before).toEqual({ status: 'observed', data: { enabled: false, source: 'default' } });
    expect(record.after).toEqual({ status: 'observed', data: { enabled: true, source: 'override' } });
    expect(record.changes).toEqual({
      status: 'computed',
      fields: {
        enabled: { before: false, after: true },
        source: { before: 'default', after: 'override' },
      },
    });
  });

  it('rejects a source value outside default/override', () => {
    expect(() =>
      processor.process({
        name: 'module.state.changed',
        version: 1,
        operation: 'update',
        before: notApplicable(),
        // `before`/`after` are `Snapshot<unknown>` at this boundary — an
        // invalid `source` is only ever caught by runtime schema validation.
        after: observed({ enabled: true, source: 'inherited' }),
      }),
    ).toThrow(AuditSnapshotValidationError);
  });

  it('runs a soft_delete end to end: the row still exists on both sides, no fabricated absence', () => {
    const record = processor.process({
      name: 'member.status.changed',
      version: 1,
      operation: 'soft_delete',
      chatId: 'chat-1',
      before: observed({ chatId: 'chat-1', userId: 'u1', status: 'member' }),
      after: observed({ chatId: 'chat-1', userId: 'u1', status: 'left' }),
    });

    expect(record.before.status).toBe('observed');
    expect(record.after.status).toBe('observed');
    expect(record.changes).toEqual({
      status: 'computed',
      fields: { status: { before: 'member', after: 'left' } },
    });
  });

  it('runs a failed operation end to end: no persisted state on either side yields an empty, not fabricated, diff', () => {
    const record = processor.process({
      name: 'integration.action',
      version: 1,
      operation: 'failed',
      before: notApplicable(),
      after: notApplicable(),
    });

    expect(record.changes).toEqual({ status: 'computed', fields: {} });
  });

  it('only allowlists message text when the policy explicitly permits it', () => {
    const withoutPolicy = processor.process({
      name: 'message.edited',
      version: 1,
      operation: 'update',
      before: observed({ chatId: '1', messageId: 'm1', userId: 'u1', editedAt: 'now', textLength: 5, text: 'hello' }),
      after: observed({ chatId: '1', messageId: 'm1', userId: 'u1', editedAt: 'now', textLength: 7, text: 'hello!!' }),
    });
    expect(withoutPolicy.after.status).toBe('observed');
    if (withoutPolicy.after.status === 'observed') {
      expect(withoutPolicy.after.data).not.toHaveProperty('text');
    }

    const withPolicy = processor.process({
      name: 'message.edited',
      version: 1,
      operation: 'update',
      policy: { allowMessageTextLogging: true },
      before: observed({ chatId: '1', messageId: 'm1', userId: 'u1', editedAt: 'now', textLength: 5, text: 'hello' }),
      after: observed({ chatId: '1', messageId: 'm1', userId: 'u1', editedAt: 'now', textLength: 7, text: 'hello!!' }),
    });
    expect(withPolicy.after.status).toBe('observed');
    if (withPolicy.after.status === 'observed') {
      expect(withPolicy.after.data).toHaveProperty('text', 'hello!!');
    }
  });
});

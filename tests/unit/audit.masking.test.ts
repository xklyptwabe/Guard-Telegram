import { describe, expect, it } from 'vitest';

import { applyAllowlist, stripForbidden } from '../../src/lib/audit/masking.js';

describe('applyAllowlist', () => {
  it('keeps only allowlisted fields, dropping everything else', () => {
    const data = { chatId: '1', moduleId: 'welcome', enabled: true, secretNote: 'nope' } as Record<string, unknown>;
    const result = applyAllowlist(data, ['chatId', 'moduleId', 'enabled']);
    expect(result).toEqual({ chatId: '1', moduleId: 'welcome', enabled: true });
    expect(result).not.toHaveProperty('secretNote');
  });

  it('evaluates conditional fields against the runtime policy', () => {
    const data = { chatId: '1', messageId: '2', userId: '3', text: 'hello world' } as Record<string, unknown>;
    const allowlist = ['chatId', 'messageId', 'userId', { field: 'text' as const, when: (p: { allowMessageTextLogging: boolean }) => p.allowMessageTextLogging }];

    const withoutPolicy = applyAllowlist(data, allowlist, { allowMessageTextLogging: false });
    expect(withoutPolicy).not.toHaveProperty('text');

    const withPolicy = applyAllowlist(data, allowlist, { allowMessageTextLogging: true });
    expect(withPolicy).toHaveProperty('text', 'hello world');
  });

  it('never includes a field the source data does not actually have', () => {
    const data = { chatId: '1' } as Record<string, unknown>;
    const result = applyAllowlist(data, ['chatId', 'moduleId']);
    expect(result).toEqual({ chatId: '1' });
  });
});

describe('stripForbidden (defense in depth)', () => {
  it('strips forbidden keys even if they somehow made it onto an allowlisted object', () => {
    const data = {
      chatId: '1',
      password: 'hunter2',
      apiToken: 'abc',
      webhookSecret: 'shh',
      connectionString: 'postgres://user:pass@host/db',
      headers: { authorization: 'Bearer xyz' },
      rawUpdate: { update_id: 1 },
      callbackData: 'payload',
      callbackPayload: { data: 'full payload' },
      fileId: 'AgAD',
      files: [{ name: 'attachment' }],
    };
    const result = stripForbidden(data);
    expect(result).toEqual({ chatId: '1' });
  });

  it('recurses into nested objects and arrays', () => {
    const data = { items: [{ token: 'x', ok: true }, { password: 'y', ok: false }] };
    const result = stripForbidden(data);
    expect(result).toEqual({ items: [{ ok: true }, { ok: false }] });
  });
});

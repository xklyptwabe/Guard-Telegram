import { describe, expect, it } from 'vitest';

import { en, ru, localeForTelegram } from '../../src/i18n/index.js';

describe('locales', () => {
  it('selects RU by default and EN for English Telegram clients', () => {
    expect(localeForTelegram(undefined)).toBe('ru');
    expect(localeForTelegram('en-US')).toBe('en');
  });

  it('keeps the command namespace present in both locales', () => {
    expect(Object.keys(ru.commands).sort()).toEqual(Object.keys(en.commands).sort());
  });
});

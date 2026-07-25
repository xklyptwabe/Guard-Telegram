import i18next, { type i18n } from 'i18next';

import en from './locales/en/index.js';
import ru from './locales/ru/index.js';

export type SupportedLocale = 'ru' | 'en';

export async function initializeI18n(): Promise<i18n> {
  const instance = i18next.createInstance();
  await instance.init({
    resources: { ru: { translation: ru }, en: { translation: en } },
    fallbackLng: 'ru',
    interpolation: { escapeValue: false },
  });
  return instance;
}

export function localeForTelegram(languageCode: string | undefined): SupportedLocale {
  return languageCode?.toLowerCase().startsWith('en') ? 'en' : 'ru';
}

export { en, ru };

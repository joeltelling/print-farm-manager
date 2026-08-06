import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';

// Adding a language later = add its JSON import + one entry here + register it in `resources` below.
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
    },
    fallbackLng: 'en',
    // Collapse region codes (e.g. en-US) to their base code (en) for detection/resolution.
    // This alone does NOT constrain i18n.language to SUPPORTED_LANGUAGES: a browser
    // reporting an unregistered language (e.g. pl) still gets cached as i18n.language,
    // with t() silently falling back to fallbackLng for the actual strings. supportedLngs
    // below is what actually keeps detection/caching within the registered set.
    load: 'languageOnly',
    supportedLngs: SUPPORTED_LANGUAGES.map(l => l.code),
    nonExplicitSupportedLngs: true,
    interpolation: {
      escapeValue: false, // React already escapes output.
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

// WHAT: the locale used for Intl date/number formatting (NOT for choosing translations).
// WHY: translations resolve to base codes (en) via supportedLngs above, but an en-GB
//      operator must still see day-first dates and their own number format. If the
//      browser's regional variant matches the active translation language, keep it
//      (resolved 'en' + navigator 'en-GB' -> 'en-GB'); otherwise the user deliberately
//      chose another language (e.g. picked 'pl' from the Settings switcher), so use
//      that language as-is with no regional guessing.
export function getFormattingLocale(i18nInstance) {
  const resolved = i18nInstance.resolvedLanguage || i18nInstance.language || 'en';
  const navLangs = (typeof navigator !== 'undefined' && navigator.languages) || [];
  const regional = navLangs.find((l) => l.split('-')[0] === resolved);
  return regional || resolved;
}

export default i18n;

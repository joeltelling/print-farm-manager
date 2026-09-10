import { useTranslation } from 'react-i18next';
import { getFormattingLocale } from './i18n';

// Re-renders whenever the active language changes (useTranslation subscribes to that),
// returning the regional locale Intl date/number formatting should use. See
// getFormattingLocale in i18n.js for why this differs from the resolved translation
// language.
export function useFormattingLocale() {
  const { i18n } = useTranslation();
  return getFormattingLocale(i18n);
}

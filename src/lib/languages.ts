export interface SupportedLanguage {
  code: string;
  label: string;
}

/**
 * Supported UI languages. English is the baseline for locale parity
 * (scripts/i18n-verify-parity.mjs and scripts/i18n-check-pair.mjs compare
 * every other locale against src/locales/en), and Vietnamese is the local
 * deployment language. Text direction is intentionally not modelled: both
 * languages are written left-to-right.
 */
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'vi', label: 'Tiếng Việt' },
];

const configuredLanguage = import.meta.env.VITE_DEFAULT_LANGUAGE;
export const DEFAULT_LANGUAGE =
  configuredLanguage && SUPPORTED_LANGUAGES.some((lang) => lang.code === configuredLanguage)
    ? configuredLanguage
    : 'en';

export const isSupportedLanguage = (code?: string): code is string =>
  !!code && SUPPORTED_LANGUAGES.some((lang) => lang.code === code);

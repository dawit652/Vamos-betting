/**
 * Locale constants without any message text, safe to import from client
 * components (`@vamos/i18n/locales`) without shipping every translation.
 */

/** Supported UI locales. Amharic is the default for Ethiopian users. */
export const LOCALES = ['am', 'en', 'om', 'ti'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'am';

/** Locales offered in the language switcher today; om and ti are prepared but not launched. */
export const LAUNCHED_LOCALES: readonly Locale[] = ['am', 'en'];

/** Native names shown in the language switcher. */
export const LOCALE_NAMES: Record<Locale, string> = {
  am: 'አማርኛ',
  en: 'English',
  om: 'Afaan Oromoo',
  ti: 'ትግርኛ',
};

/**
 * Locales whose translations have not yet been reviewed by a native speaker.
 * The UI shows them but they must be reviewed before a licensed launch.
 */
export const UNREVIEWED_LOCALES: readonly Locale[] = ['am', 'om', 'ti'];

/** Message namespaces; each has its own file per locale under `src/messages/<locale>/`. */
export const NAMESPACES = ['common', 'sportsbook', 'account'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** The locale for a raw value (cookie, header), falling back to Amharic. */
export function resolveLocale(value: string | null | undefined): Locale {
  return value !== null && value !== undefined && isLocale(value) ? value : DEFAULT_LOCALE;
}

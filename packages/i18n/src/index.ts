import { am } from './messages/am';
import { en, type Messages } from './messages/en';
import { om } from './messages/om';
import { ti } from './messages/ti';

export type { Messages };

/** Supported UI locales. Amharic is the default for Ethiopian users. */
export const LOCALES = ['am', 'en', 'om', 'ti'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'am';

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

export const MESSAGES: Record<Locale, Messages> = { am, en, om, ti };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function messagesFor(locale: string): Messages {
  return isLocale(locale) ? MESSAGES[locale] : MESSAGES[DEFAULT_LOCALE];
}

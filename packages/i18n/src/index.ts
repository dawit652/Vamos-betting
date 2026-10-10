import { resolveLocale, type Locale } from './locales';
import { am } from './messages/am';
import { en, type Messages } from './messages/en';
import { om } from './messages/om';
import { ti } from './messages/ti';

/*
 * Server-side entry: it bundles every locale's messages. Client components import
 * `@vamos/i18n/locales` and `@vamos/i18n/translate` instead (no message text), and
 * receive the current locale's messages from the server through a provider.
 */

export type { Messages };
export { withFallback, type DeepPartial } from './fallback';
export * from './locales';
export {
  createTranslator,
  interpolate,
  lookup,
  placeholders,
  type MessageKey,
  type MessageVars,
  type Translator,
} from './translate';

export const MESSAGES: Record<Locale, Messages> = { am, en, om, ti };

export function messagesFor(locale: string): Messages {
  return MESSAGES[resolveLocale(locale)];
}

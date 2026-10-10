import 'server-only';
import {
  createTranslator,
  MESSAGES,
  resolveLocale,
  type Locale,
  type Messages,
  type Translator,
} from '@vamos/i18n';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { LOCALE_COOKIE } from '@/lib/cookies';

/**
 * Server components: `const t = await getT();` then `t('common.nav.home')`.
 * The locale comes from the `vamos_locale` cookie (default Amharic). Reading it
 * makes the route dynamic, which the live sportsbook pages are anyway.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
});

const translators = new Map<Locale, Translator>();

export function translatorFor(locale: Locale): Translator {
  let t = translators.get(locale);
  if (t === undefined) {
    t = createTranslator(MESSAGES[locale]);
    translators.set(locale, t);
  }
  return t;
}

export async function getT(): Promise<Translator> {
  return translatorFor(await getLocale());
}

/** The current locale's full message tree (handed to the client provider by the root layout). */
export async function getMessages(): Promise<Messages> {
  return MESSAGES[await getLocale()];
}

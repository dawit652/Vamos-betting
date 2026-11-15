'use client';

import type { Messages } from '@vamos/i18n';
import type { Locale, Namespace } from '@vamos/i18n/locales';
import { createTranslator, type Translator } from '@vamos/i18n/translate';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/cookies';

/**
 * Client components: `const t = useT();` then `t('common.nav.home')`.
 *
 * Messages reach the browser through the RSC payload, never through the JS
 * bundle, and only the namespaces a subtree needs: the root layout sends
 * `common` and `sportsbook`; a route whose client islands need another
 * namespace wraps them in <ClientMessages namespaces={['account']}> (from
 * '@/i18n/ClientMessages'), which adds it on top. A key whose namespace was not
 * sent renders as the key itself, e.g. "account.login.title".
 */

export type ClientMessages = Partial<Pick<Messages, Namespace>>;

interface I18nValue {
  locale: Locale;
  messages: ClientMessages;
  t: Translator;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: ClientMessages;
  children: ReactNode;
}) {
  const parent = useContext(I18nContext);
  const value = useMemo(() => {
    const merged = parent === null ? messages : { ...parent.messages, ...messages };
    // lookup() walks plain objects; a missing namespace falls back to the key.
    return { locale, messages: merged, t: createTranslator(merged as Messages) };
  }, [locale, messages, parent]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

/** The messages this subtree can read (the betslip's lazy code adds its own texts to them). */
export function useClientMessages(): ClientMessages {
  return useI18n().messages;
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useT/useLocale must be used inside <I18nProvider>');
  return value;
}

export function useT(): Translator {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

/** Stores the locale in the `vamos_locale` cookie and re-renders the server components. */
export function useSetLocale(): (locale: Locale) => void {
  const router = useRouter();
  return useCallback(
    (locale: Locale) => {
      document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
      router.refresh();
    },
    [router],
  );
}

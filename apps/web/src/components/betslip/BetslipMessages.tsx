'use client';

import type { Messages } from '@vamos/i18n';
import { loadBetslipMessages, type BetslipMessages as Text } from '@vamos/i18n/betslip';
import { isLocale, type Locale } from '@vamos/i18n/locales';
import { use, useMemo, type ReactNode } from 'react';
import { I18nProvider, useClientMessages, useLocale } from '@/i18n/client';

const loaded = new Map<Locale, Promise<Text>>();

/**
 * Loads the betslip drawer's text for a locale, once per locale. This module is
 * part of the drawer's lazy chunk, never of the page's own JS.
 */
function preloadBetslipMessages(locale: Locale): Promise<Text> {
  let pending = loaded.get(locale);
  if (pending === undefined) {
    pending = loadBetslipMessages(locale).catch((error: unknown) => {
      loaded.delete(locale); // a failed chunk (offline) is retried on the next open
      throw error;
    });
    loaded.set(locale, pending);
  }
  return pending;
}

// The chunk loads on the first intent to open the slip: start on the text right
// away (the page's locale is <html lang>) rather than when the drawer renders.
if (typeof document !== 'undefined' && isLocale(document.documentElement.lang)) {
  preloadBetslipMessages(document.documentElement.lang).catch(() => undefined);
}

/**
 * Adds the drawer-only `sportsbook.betslip.*` text, which the root layout leaves
 * out of every page (`withoutDrawerText`), for the slip below it. Suspends until
 * the text has loaded; wrap it in <Suspense>.
 */
export function BetslipMessages({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const betslip = use(preloadBetslipMessages(locale));
  const parent = useClientMessages();
  const messages = useMemo(
    () => ({
      sportsbook: { ...parent.sportsbook, betslip } as Messages['sportsbook'],
    }),
    [parent.sportsbook, betslip],
  );
  return (
    <I18nProvider locale={locale} messages={messages}>
      {children}
    </I18nProvider>
  );
}

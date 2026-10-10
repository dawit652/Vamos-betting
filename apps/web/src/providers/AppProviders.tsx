'use client';

import type { Locale } from '@vamos/i18n/locales';
import type { ReactNode } from 'react';
import { I18nProvider, type ClientMessages } from '@/i18n/client';
import { BetslipProvider } from './BetslipProvider';
import { SessionProvider } from './SessionProvider';

/** Every client-side context, mounted once by the root layout. */
export function AppProviders({
  locale,
  messages,
  hasSessionCookie,
  children,
}: {
  locale: Locale;
  messages: ClientMessages;
  hasSessionCookie: boolean;
  children: ReactNode;
}) {
  return (
    <I18nProvider locale={locale} messages={messages}>
      <SessionProvider hasSessionCookie={hasSessionCookie}>
        <BetslipProvider>{children}</BetslipProvider>
      </SessionProvider>
    </I18nProvider>
  );
}

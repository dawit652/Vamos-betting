import type { Messages } from '@vamos/i18n';
import type { ReactNode } from 'react';
import { I18nProvider, type ClientMessages } from '@/i18n/client';
import { getLocale, getMessages } from '@/i18n/server';

/**
 * Server component: sends the `account` messages (and the full `sportsbook`
 * namespace) to the client components below it, like
 * <ClientMessages namespaces={['account']}>, but without the
 * long help / terms / responsible-gambling texts (`account.pages`), which only
 * server components render. That keeps the RSC payload of the account pages small.
 */
export async function AccountMessages({ children }: { children: ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  return (
    <I18nProvider locale={locale} messages={clientAccountMessages(messages)}>
      {children}
    </I18nProvider>
  );
}

export function clientAccountMessages(messages: Messages): ClientMessages {
  const { pages: _pages, ...rest } = messages.account;
  // Every key a client component can ask for is still there; `account.pages.*` is server-only.
  // The full sportsbook namespace again: the root layout leaves out `sportsbook.betslip.*`,
  // which some account forms reuse (jackpot errors).
  return { account: rest as Messages['account'], sportsbook: messages.sportsbook };
}

import type { Namespace } from '@vamos/i18n';
import type { ReactNode } from 'react';
import { I18nProvider, type ClientMessages as Subset } from './client';
import { getLocale, getMessages } from './server';

/**
 * Server component: makes extra message namespaces available to `useT()` in the
 * client components below it, e.g. in `app/account/layout.tsx`:
 *
 *   <ClientMessages namespaces={['account']}>{children}</ClientMessages>
 *
 * Server components never need this: `getT()` sees every namespace.
 */
export async function ClientMessages({
  namespaces,
  children,
}: {
  namespaces: readonly Namespace[];
  children: ReactNode;
}) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);
  return (
    <I18nProvider locale={locale} messages={pickNamespaces(messages, namespaces)}>
      {children}
    </I18nProvider>
  );
}

export function pickNamespaces(
  messages: Required<Subset>,
  namespaces: readonly Namespace[],
): Subset {
  const subset: Subset = {};
  for (const ns of namespaces) Object.assign(subset, { [ns]: messages[ns] });
  return subset;
}

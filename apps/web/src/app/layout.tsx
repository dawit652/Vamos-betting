import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { BetslipHost } from '@/components/betslip/BetslipHost';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { DemoBanner } from '@/components/shell/DemoBanner';
import { Footer } from '@/components/shell/Footer';
import { Header } from '@/components/shell/Header';
import { withoutDrawerText } from '@vamos/i18n/betslip';
import type { Messages } from '@vamos/i18n';
import { pickNamespaces } from '@/i18n/ClientMessages';
import type { ClientMessages as ClientMessagesSubset } from '@/i18n/client';
import { getLocale, getMessages } from '@/i18n/server';
import { CSRF_COOKIE, parseTheme, THEME_COLORS, THEME_COOKIE } from '@/lib/cookies';
import { AppProviders } from '@/providers/AppProviders';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Vamos', template: '%s · Vamos' },
  description: 'Vamos – simple, fast sports betting for Ethiopia (demo, play money only)',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: { capable: true, title: 'Vamos', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

/** The browser bar takes the header colour of the visitor's theme. */
export async function generateViewport(): Promise<Viewport> {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return {
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    themeColor: THEME_COLORS[theme],
  };
}

/** Message namespaces every client component can use; others need <ClientMessages>. */
const ROOT_CLIENT_NAMESPACES = ['common', 'sportsbook'] as const;

/**
 * The root namespaces, minus the betslip drawer's own text: the drawer loads that
 * with its code (`<BetslipMessages>`), so pages that never open the slip skip it.
 */
function rootClientMessages(messages: Messages): ClientMessagesSubset {
  return {
    ...pickNamespaces(messages, ROOT_CLIENT_NAMESPACES),
    sportsbook: withoutDrawerText(messages.sportsbook) as Messages['sportsbook'],
  };
}

/**
 * App shell: sticky header + DEMO banner, the page, footer and the betslip bar.
 * The header holds the main navigation: its links on wide screens, the fixed
 * bottom bar on phones.
 * Pages render inside <main>; they must not add their own shell. Sportsbook pages
 * wrap themselves in <SportsbookFrame> (sport rail, side columns); account and
 * static pages keep a narrow column (`mx-auto max-w-2xl`) of their own.
 * The theme is the `vamos_theme` cookie, rendered as `<html data-theme>`.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, messages, cookieStore] = await Promise.all([
    getLocale(),
    getMessages(),
    cookies(),
  ]);
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  return (
    <html lang={locale} data-theme={theme}>
      <body className="min-h-dvh pb-[calc(var(--spacing-bottom-nav)+env(safe-area-inset-bottom))] lg:pb-0">
        <AppProviders
          locale={locale}
          messages={rootClientMessages(messages)}
          hasSessionCookie={cookieStore.has(CSRF_COOKIE)}
        >
          <div className="sticky top-0 z-30">
            <Header theme={theme} />
            <DemoBanner />
          </div>
          <main className="mx-auto max-w-7xl">{children}</main>
          <Footer />
          <BetslipHost />
        </AppProviders>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}

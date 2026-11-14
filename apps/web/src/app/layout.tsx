import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { BetslipHost } from '@/components/betslip/BetslipHost';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { BottomNav } from '@/components/shell/BottomNav';
import { DemoBanner } from '@/components/shell/DemoBanner';
import { Footer } from '@/components/shell/Footer';
import { Header } from '@/components/shell/Header';
import { pickNamespaces } from '@/i18n/ClientMessages';
import { getLocale, getMessages } from '@/i18n/server';
import { CSRF_COOKIE, parseTheme, THEME_COOKIE } from '@/lib/cookies';
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

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0d1613',
};

/** Message namespaces every client component can use; others need <ClientMessages>. */
const ROOT_CLIENT_NAMESPACES = ['common', 'sportsbook'] as const;

/**
 * App shell: sticky header + DEMO banner, the page, footer, the betslip bar and
 * the fixed bottom nav (phones; wide screens get the header links instead).
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
          messages={pickNamespaces(messages, ROOT_CLIENT_NAMESPACES)}
          hasSessionCookie={cookieStore.has(CSRF_COOKIE)}
        >
          <div className="sticky top-0 z-30">
            <Header theme={theme} />
            <DemoBanner />
          </div>
          <main className="mx-auto max-w-7xl">{children}</main>
          <Footer />
          <BetslipHost />
          <BottomNav />
        </AppProviders>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}

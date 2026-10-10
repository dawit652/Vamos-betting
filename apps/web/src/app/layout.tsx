import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { BetslipHost } from '@/components/betslip/BetslipHost';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { BottomNav } from '@/components/shell/BottomNav';
import { DemoBanner } from '@/components/shell/DemoBanner';
import { Footer } from '@/components/shell/Footer';
import { Header } from '@/components/shell/Header';
import { SportChips } from '@/components/shell/SportChips';
import { pickNamespaces } from '@/i18n/ClientMessages';
import { getLocale, getMessages } from '@/i18n/server';
import { CSRF_COOKIE } from '@/lib/cookies';
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
  themeColor: '#0a5c36',
};

/** Message namespaces every client component can use; others need <ClientMessages>. */
const ROOT_CLIENT_NAMESPACES = ['common', 'sportsbook'] as const;

/**
 * App shell: sticky header + DEMO banner, sport chips (sport and live lists only),
 * the page, footer, floating betslip button and the fixed bottom nav.
 * Pages render inside <main>; they must not add their own shell.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, messages, cookieStore] = await Promise.all([
    getLocale(),
    getMessages(),
    cookies(),
  ]);
  return (
    <html lang={locale}>
      <body className="min-h-dvh pb-[calc(var(--spacing-bottom-nav)+env(safe-area-inset-bottom))]">
        <AppProviders
          locale={locale}
          messages={pickNamespaces(messages, ROOT_CLIENT_NAMESPACES)}
          hasSessionCookie={cookieStore.has(CSRF_COOKIE)}
        >
          <div className="sticky top-0 z-30">
            <Header />
            <DemoBanner />
          </div>
          <SportChips />
          <main className="mx-auto max-w-2xl">{children}</main>
          <Footer />
          <BetslipHost />
          <BottomNav />
        </AppProviders>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}

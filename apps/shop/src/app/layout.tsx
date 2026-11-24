import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { PrintSettingsApplier } from '@/components/print-settings';
import { SessionProvider } from '@/components/session';
import { Shell } from '@/components/shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nahubet Shop',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request, so it carries the nonce of its own Content Security Policy
  // (src/proxy.ts); a page prerendered at build time could not.
  await connection();
  return (
    <html lang="en">
      <body>
        <PrintSettingsApplier />
        <SessionProvider>
          <Shell>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}

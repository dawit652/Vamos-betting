import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/components/session';
import { Shell } from '@/components/shell';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nahubet Back Office',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Every page renders per request, so it carries the nonce of its own Content Security Policy
  // (src/proxy.ts); a page prerendered at build time could not.
  await connection();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme}>
      <body>
        <SessionProvider>
          <Shell theme={theme}>{children}</Shell>
        </SessionProvider>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vamos',
  description: 'Vamos – simple, fast sports betting for Ethiopia (demo)',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b6e4f',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="am">
      <body>{children}</body>
    </html>
  );
}

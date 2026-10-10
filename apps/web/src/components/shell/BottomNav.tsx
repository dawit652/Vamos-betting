'use client';

import type { MessageKey } from '@vamos/i18n/translate';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { routes } from '@/lib/routes';

interface Item {
  href: string;
  label: MessageKey;
  icon: ReactNode;
  active: (path: string) => boolean;
}

const icon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

const ITEMS: readonly Item[] = [
  {
    href: routes.home,
    label: 'common.nav.home',
    icon: icon('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'),
    active: (p) => p === '/' || p.startsWith('/sport/') || p.startsWith('/event/'),
  },
  {
    href: routes.live(),
    label: 'common.nav.live',
    icon: icon(
      'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
    ),
    active: (p) => p === '/live' || p.startsWith('/live/'),
  },
  {
    href: routes.myBets,
    label: 'common.nav.myBets',
    icon: icon('M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3'),
    active: (p) => p.startsWith(routes.myBets),
  },
  {
    href: routes.account,
    label: 'common.nav.account',
    icon: icon('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'),
    active: (p) =>
      [routes.account, routes.wallet, routes.login, routes.register, routes.forgotPassword].some(
        (r) => p === r || p.startsWith(`${r}/`),
      ),
  },
];

/** Fixed bottom navigation: Home, Live, My Bets, Account. */
export function BottomNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav
      aria-label={t('common.nav.main')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto grid h-bottom-nav max-w-2xl grid-cols-4">
        {ITEMS.map((item) => {
          const active = item.active(pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex h-full flex-col items-center justify-center gap-0.5 text-xxs font-semibold ${
                  active ? 'text-brand' : 'text-muted'
                }`}
              >
                {item.icon}
                {t(item.label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

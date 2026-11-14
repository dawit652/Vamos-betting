'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { NAV_ITEMS } from './nav-items';

/**
 * The main navigation (Home, Live, My Bets, Jackpot, Account), rendered once
 * inside the header: a fixed bottom bar with icons on phones and tablets, plain
 * header links from the `lg` breakpoint up.
 */
export function MainNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav
      aria-label={t('common.nav.main')}
      className="fixed inset-x-0 bottom-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:static lg:border-0 lg:bg-transparent lg:pb-0"
    >
      <ul className="mx-auto grid h-bottom-nav max-w-2xl grid-cols-5 lg:flex lg:h-auto lg:gap-1">
        {NAV_ITEMS.map((item) => {
          const active = item.active(pathname);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-full flex-col items-center justify-center gap-0.5 text-xxs font-semibold lg:flex-row lg:gap-1.5 lg:rounded-full lg:px-3 lg:py-1.5 lg:text-sm ${
                  active ? 'text-brand lg:bg-white/15' : 'text-muted lg:opacity-70'
                } lg:text-chrome-ink`}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-brand lg:hidden"
                  />
                ) : null}
                <span className="relative lg:hidden">
                  {item.icon}
                  {item.id === 'live' ? (
                    <span aria-hidden="true" className="live-dot absolute -top-0.5 -right-1" />
                  ) : null}
                </span>
                {t(item.label)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

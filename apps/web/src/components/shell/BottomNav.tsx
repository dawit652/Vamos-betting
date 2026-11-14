'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { NAV_ITEMS } from './nav-items';

/** Fixed bottom navigation on phones and tablets: Home, Live, My Bets, Jackpot, Account. */
export function BottomNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav
      aria-label={t('common.nav.main')}
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid h-bottom-nav max-w-2xl grid-cols-5">
        {NAV_ITEMS.map((item) => {
          const active = item.active(pathname);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`relative flex h-full flex-col items-center justify-center gap-0.5 text-xxs font-semibold ${
                  active ? 'text-brand' : 'text-muted'
                }`}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-brand"
                  />
                ) : null}
                <span className="relative">
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

/** The same destinations as header links, shown from the `lg` breakpoint up. */
export function TopNav() {
  const t = useT();
  const pathname = usePathname();
  return (
    <nav aria-label={t('common.nav.main')} className="hidden items-center gap-1 lg:flex">
      {NAV_ITEMS.map((item) => {
        const active = item.active(pathname);
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${
              active ? 'bg-white/15 text-chrome-ink' : 'text-chrome-ink/70 hover:text-chrome-ink'
            }`}
          >
            {item.id === 'live' ? <span aria-hidden="true" className="live-dot" /> : null}
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );
}

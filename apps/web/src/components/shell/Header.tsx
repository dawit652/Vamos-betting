import Link from 'next/link';
import { getT } from '@/i18n/server';
import type { Theme } from '@/lib/cookies';
import { IS_DEMO } from '@/lib/mode';
import { routes } from '@/lib/routes';
import { HeaderAccount } from './HeaderAccount';
import { LocaleToggle } from './LocaleSwitcher';
import { MainNav } from './MainNav';
import { ThemeToggle } from './ThemeToggle';

/**
 * Top bar: logo, the main navigation (header links on wide screens; the same element is
 * the fixed bottom bar on phones), theme and language toggles, then the balance (signed in)
 * or log in / register.
 */
export async function Header({ theme }: { theme: Theme }) {
  const t = await getT();
  return (
    <header className="border-b border-white/20 bg-chrome text-chrome-ink">
      <div className="mx-auto flex h-header max-w-7xl items-center gap-1.5 px-3 lg:gap-4 lg:px-4">
        <Link
          href={routes.home}
          className="text-xl font-black tracking-tight italic lg:text-2xl"
          aria-label={t('common.nav.home')}
        >
          Nahubet<span className="text-accent">.</span>
        </Link>
        {IS_DEMO ? (
          <span className="rounded-md bg-accent px-1 text-xxs font-extrabold text-accent-ink">
            {t('common.demo.badge')}
          </span>
        ) : null}
        <MainNav />
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle initial={theme} />
          <Link
            href={routes.search}
            prefetch={false}
            aria-label={t('sportsbook.search.open')}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-white/20 text-chrome-ink"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </Link>
          <LocaleToggle />
          <HeaderAccount />
        </div>
      </div>
    </header>
  );
}

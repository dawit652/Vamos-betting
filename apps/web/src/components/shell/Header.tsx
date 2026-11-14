import Link from 'next/link';
import { getT } from '@/i18n/server';
import type { Theme } from '@/lib/cookies';
import { routes } from '@/lib/routes';
import { TopNav } from './BottomNav';
import { HeaderAccount } from './HeaderAccount';
import { LocaleToggle } from './LocaleSwitcher';
import { ThemeToggle } from './ThemeToggle';

/**
 * Top bar: logo, the main navigation (wide screens only; phones use the bottom bar), theme
 * and language toggles, then the balance (signed in) or log in / register.
 */
export async function Header({ theme }: { theme: Theme }) {
  const t = await getT();
  return (
    <header className="border-b border-white/10 bg-chrome text-chrome-ink">
      <div className="mx-auto flex h-header max-w-7xl items-center gap-1.5 px-3 sm:gap-2 lg:gap-4 lg:px-4">
        <Link
          href={routes.home}
          className="text-xl font-black tracking-tight italic sm:text-2xl"
          aria-label={t('common.nav.home')}
        >
          Vamos<span className="text-accent">.</span>
        </Link>
        <span className="rounded-md bg-accent px-1 py-px text-[0.625rem] font-extrabold text-accent-ink sm:px-1.5 sm:py-0.5 sm:text-xxs">
          {t('common.demo.badge')}
        </span>
        <TopNav />
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle initial={theme} />
          <LocaleToggle />
          <HeaderAccount />
        </div>
      </div>
    </header>
  );
}

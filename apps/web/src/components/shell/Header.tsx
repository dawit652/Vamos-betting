import Link from 'next/link';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';
import { HeaderAccount } from './HeaderAccount';
import { LocaleToggle } from './LocaleSwitcher';

/** Dark green top bar: logo, language toggle, then balance (signed in) or log in / register. */
export async function Header() {
  const t = await getT();
  return (
    <header className="bg-brand text-brand-ink">
      <div className="mx-auto flex h-header max-w-2xl items-center gap-2 px-3">
        <Link
          href={routes.home}
          className="text-xl font-black tracking-tight"
          aria-label={t('common.nav.home')}
        >
          Nahubet<span className="text-accent">.</span>
        </Link>
        <span className="rounded-sm bg-accent px-1 text-xxs font-bold text-accent-ink">
          {t('common.demo.badge')}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <LocaleToggle />
          <HeaderAccount />
        </div>
      </div>
    </header>
  );
}

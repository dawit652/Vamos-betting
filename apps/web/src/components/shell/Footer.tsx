import Link from 'next/link';
import { getT } from '@/i18n/server';
import type { Theme } from '@/lib/cookies';
import { routes } from '@/lib/routes';
import { telegramUrl } from '@/lib/telegram';
import { LocaleSwitcher } from './LocaleSwitcher';
import { TelegramLink } from './TelegramLink';
import { ThemeToggle } from './ThemeToggle';

/** Footer card: logo and tagline, language, legal links and the age notice. */
export async function Footer({ theme }: { theme: Theme }) {
  const t = await getT();
  const telegram = telegramUrl();
  return (
    <footer className="mx-auto mt-8 max-w-7xl px-3 pb-6 lg:px-4">
      <div className="card space-y-4 p-4 text-xs text-muted">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xl font-black tracking-tight text-ink italic">
              Nahubet<span className="text-accent-strong">.</span>
            </p>
            <p>{t('common.app.tagline')}</p>
          </div>
          <div className="flex items-center gap-2">
            <LocaleSwitcher />
            {/* Phones only: the header has no room for the theme toggle there. */}
            <span className="contents sm:hidden">
              <ThemeToggle initial={theme} className="border-line text-ink" />
            </span>
          </div>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-3 font-semibold">
          <Link href={routes.help} prefetch={false}>
            {t('common.nav.help')}
          </Link>
          <Link href={routes.terms} prefetch={false}>
            {t('common.nav.terms')}
          </Link>
          <Link href={routes.privacy} prefetch={false}>
            {t('common.nav.privacy')}
          </Link>
          <Link href={routes.responsibleGambling} prefetch={false}>
            {t('common.nav.responsibleGambling')}
          </Link>
          {telegram !== null ? (
            <TelegramLink href={telegram} label={t('common.telegram.join')} className="text-ink" />
          ) : null}
        </nav>
        <p className="flex items-center gap-2 font-semibold text-ink">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-line text-xxs font-extrabold">
            21+
          </span>
          {t('common.rg.ageNotice')}
        </p>
      </div>
    </footer>
  );
}

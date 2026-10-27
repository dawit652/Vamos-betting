import Link from 'next/link';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';
import { LocaleSwitcher } from './LocaleSwitcher';

/** Footer: language, legal links and the age notice. */
export async function Footer() {
  const t = await getT();
  return (
    <footer className="mx-auto mt-6 max-w-2xl space-y-3 px-3 pb-6 text-xs text-muted">
      <LocaleSwitcher />
      <nav className="flex flex-wrap gap-x-4 gap-y-1">
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
      </nav>
      <p className="font-semibold">{t('common.rg.ageNotice')}</p>
    </footer>
  );
}

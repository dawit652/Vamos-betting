import type { Metadata } from 'next';
import Link from 'next/link';
import { StaticPage } from '@/components/account/StaticPage';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.pages.help.title') };
}

const ITEMS = ['bet', 'money', 'bets', 'password', 'age', 'contact'] as const;

/** Short FAQ; each answer opens in place (no JavaScript). */
export default async function HelpPage() {
  const t = await getT();
  return (
    <StaticPage title={t('account.pages.help.title')} intro={t('account.pages.help.intro')}>
      <div className="card divide-y divide-line p-0">
        {ITEMS.map((item) => (
          <details key={item} className="group px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold">
              {t(`account.pages.help.items.${item}.q`)}
              <span aria-hidden="true" className="text-muted group-open:rotate-90">
                ›
              </span>
            </summary>
            <p className="pt-1 leading-relaxed text-muted">
              {t(`account.pages.help.items.${item}.a`)}
            </p>
          </details>
        ))}
      </div>
      <nav className="flex flex-wrap gap-2">
        <Link href={routes.terms} prefetch={false} className="chip">
          {t('common.nav.terms')}
        </Link>
        <Link href={routes.responsibleGambling} prefetch={false} className="chip">
          {t('common.nav.responsibleGambling')}
        </Link>
      </nav>
    </StaticPage>
  );
}

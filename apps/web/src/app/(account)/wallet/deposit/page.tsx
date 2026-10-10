import type { Metadata } from 'next';
import Link from 'next/link';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.wallet.depositPage.title') };
}

/** Placeholder: real deposits need an ELS licence (Phase 6); the app runs on play money. */
export default async function DepositPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.wallet}>{t('account.wallet.back')}</BackLink>}>
        {t('account.wallet.depositPage.title')}
      </PageTitle>
      <section className="card mx-3 space-y-3">
        <p className="rounded bg-demo-bg px-3 py-2 text-xs font-semibold text-demo-ink">
          {t('common.demo.banner')}
        </p>
        <p>{t('account.wallet.depositPage.body')}</p>
        <p className="text-muted">{t('account.wallet.depositPage.useTopUp')}</p>
        <Link href={routes.wallet} className="btn btn-accent w-full">
          {t('account.wallet.back')}
        </Link>
      </section>
    </>
  );
}

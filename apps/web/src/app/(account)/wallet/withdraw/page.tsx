import type { Metadata } from 'next';
import Link from 'next/link';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.wallet.withdrawPage.title') };
}

/** Placeholder: play money cannot be withdrawn; real withdrawals need a licence and KYC. */
export default async function WithdrawPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.wallet}>{t('account.wallet.back')}</BackLink>}>
        {t('account.wallet.withdrawPage.title')}
      </PageTitle>
      <section className="card mx-3 space-y-3">
        <p className="rounded bg-demo-bg px-3 py-2 text-xs font-semibold text-demo-ink">
          {t('common.demo.banner')}
        </p>
        <p>{t('account.wallet.withdrawPage.body')}</p>
        <Link href={routes.wallet} className="btn btn-outline w-full">
          {t('account.wallet.back')}
        </Link>
      </section>
    </>
  );
}

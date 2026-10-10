import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { firstParam } from '@/components/account/paths';
import { BackLink, PageTitle } from '@/components/account/ui';
import { DepositPanel } from '@/components/payments/DepositView';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.wallet.depositPage.title') };
}

/** Deposit with the enabled provider (the play-money mock in demo mode). */
export default async function DepositPage(props: PageProps<'/wallet/deposit'>) {
  const [t, query] = await Promise.all([getT(), props.searchParams]);
  // A hosted checkout returns here with ?id=<deposit id>.
  const id = firstParam(query.id);
  return (
    <>
      <PageTitle back={<BackLink href={routes.wallet}>{t('account.wallet.back')}</BackLink>}>
        {t('account.wallet.depositPage.title')}
      </PageTitle>
      <AuthGate>
        <DepositPanel resumeId={id !== undefined && id.length <= 64 ? id : null} />
      </AuthGate>
    </>
  );
}

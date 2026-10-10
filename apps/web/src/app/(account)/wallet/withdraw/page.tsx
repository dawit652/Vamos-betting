import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { BackLink, PageTitle } from '@/components/account/ui';
import { WithdrawPanel } from '@/components/payments/WithdrawView';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.wallet.withdrawPage.title') };
}

/** Withdraw to the player's own registered phone, and track every withdrawal. */
export default async function WithdrawPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.wallet}>{t('account.wallet.back')}</BackLink>}>
        {t('account.wallet.withdrawPage.title')}
      </PageTitle>
      <AuthGate>
        <WithdrawPanel />
      </AuthGate>
    </>
  );
}

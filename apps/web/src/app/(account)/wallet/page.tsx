import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { firstParam } from '@/components/account/paths';
import { PageTitle } from '@/components/account/ui';
import { WalletView } from '@/components/account/WalletView';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.wallet.title') };
}

export default async function WalletPage(props: PageProps<'/wallet'>) {
  const [t, query] = await Promise.all([getT(), props.searchParams]);
  return (
    <>
      <PageTitle>{t('account.wallet.title')}</PageTitle>
      <AuthGate>
        <WalletView welcome={firstParam(query.welcome) === '1'} />
      </AuthGate>
    </>
  );
}

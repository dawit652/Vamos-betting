import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { KycView } from '@/components/account/KycView';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.kyc.title') };
}

/** Fayda ID verification (mock provider in demo mode). */
export default async function KycPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.account}>{t('account.title')}</BackLink>}>
        {t('account.kyc.title')}
      </PageTitle>
      <AuthGate>
        <KycView />
      </AuthGate>
    </>
  );
}

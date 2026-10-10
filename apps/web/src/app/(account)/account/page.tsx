import type { Metadata } from 'next';
import { AccountOverview } from '@/components/account/AccountOverview';
import { AuthGate } from '@/components/account/AuthGate';
import { PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.title') };
}

/** Profile, language, settings menu (KYC, limits, breaks) and log out. */
export default async function AccountPage() {
  const t = await getT();
  return (
    <>
      <PageTitle>{t('account.title')}</PageTitle>
      <AuthGate>
        <AccountOverview />
      </AuthGate>
    </>
  );
}

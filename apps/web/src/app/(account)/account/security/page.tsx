import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { SecurityView } from '@/components/account/SecurityView';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.security.title') };
}

/** Change the password (POST /me/password) and see or end sessions (/me/sessions). */
export default async function SecurityPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.account}>{t('account.title')}</BackLink>}>
        {t('account.security.title')}
      </PageTitle>
      <AuthGate>
        <SecurityView />
      </AuthGate>
    </>
  );
}

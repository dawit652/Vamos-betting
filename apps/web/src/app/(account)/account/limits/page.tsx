import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { LimitsForm } from '@/components/account/LimitsForm';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.limits.title') };
}

/** Deposit, loss and stake limits (GET/PUT /me/limits). */
export default async function LimitsPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.account}>{t('account.title')}</BackLink>}>
        {t('account.limits.title')}
      </PageTitle>
      <AuthGate>
        <LimitsForm />
      </AuthGate>
    </>
  );
}

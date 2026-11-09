import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { BackLink, PageTitle } from '@/components/account/ui';
import { DevPhonePanel } from '@/components/payments/DevPhone';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.payments.dev.title') };
}

/**
 * Demo-only simulated phone. The page always exists, but the panel renders the
 * phone only when GET /payments/options reports `demo: true` (the API serves
 * the simulator only in demo mode with the mock provider, production demos included).
 */
export default async function DevPhonePage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.wallet}>{t('account.wallet.back')}</BackLink>}>
        {t('account.payments.dev.title')}
      </PageTitle>
      <AuthGate>
        <DevPhonePanel />
      </AuthGate>
    </>
  );
}

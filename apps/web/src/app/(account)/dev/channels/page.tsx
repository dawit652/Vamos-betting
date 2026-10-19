import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { BackLink, PageTitle } from '@/components/account/ui';
import { DevChannelsPanel } from '@/components/channels/DevChannels';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.channelsDev.title') };
}

/**
 * Demo-only SMS and USSD simulator. The page always exists, but the panel renders only when
 * GET /payments/options reports `demo: true`; the API serves the dev routes only in demo mode,
 * outside production, with the channel switched on (otherwise they answer 404).
 */
export default async function DevChannelsPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.wallet}>{t('account.wallet.back')}</BackLink>}>
        {t('account.channelsDev.title')}
      </PageTitle>
      <AuthGate>
        <DevChannelsPanel />
      </AuthGate>
    </>
  );
}

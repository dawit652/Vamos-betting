import type { Metadata } from 'next';
import { AuthGate } from '@/components/account/AuthGate';
import { BetDetail } from '@/components/account/BetDetail';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.myBets.title') };
}

/** One bet: legs, amounts and timeline. */
export default async function BetDetailPage(props: PageProps<'/my-bets/[id]'>) {
  const [t, { id }] = await Promise.all([getT(), props.params]);
  return (
    <>
      <PageTitle back={<BackLink href={routes.myBets}>{t('account.myBets.allBets')}</BackLink>}>
        {t('account.myBets.details')}
      </PageTitle>
      <AuthGate>
        <BetDetail id={id} />
      </AuthGate>
    </>
  );
}

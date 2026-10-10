import type { Metadata } from 'next';
import { ExclusionView } from '@/components/account/ExclusionView';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.exclusion.title') };
}

/**
 * Cool-off and self-exclusion (POST /me/exclusions) with an explicit confirmation.
 * ExclusionView checks the session itself so its result stays visible after a
 * self-exclusion signs the player out.
 */
export default async function SelfExclusionPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.account}>{t('account.title')}</BackLink>}>
        {t('account.exclusion.title')}
      </PageTitle>
      <ExclusionView />
    </>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShopResetFlow } from '@/components/account/ShopResetFlow';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';
import { shopPinResetEnabled } from '@/lib/shop-reset';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.shopReset.title') };
}

/** Forgot PIN at a shop: the desk code on this phone; only this phone sets the new PIN. */
export default async function ResetAtShopPage() {
  if (!shopPinResetEnabled()) notFound();
  const t = await getT();
  return (
    <>
      <PageTitle
        back={<BackLink href={routes.forgotPassword}>{t('account.forgot.title')}</BackLink>}
      >
        {t('account.shopReset.title')}
      </PageTitle>
      <ShopResetFlow />
    </>
  );
}

import type { Metadata } from 'next';
import { ResetForm } from '@/components/account/ResetForm';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.reset.title') };
}

export default async function ResetPasswordPage() {
  const t = await getT();
  return (
    <>
      <PageTitle back={<BackLink href={routes.login}>{t('account.login.title')}</BackLink>}>
        {t('account.reset.title')}
      </PageTitle>
      <ResetForm />
    </>
  );
}

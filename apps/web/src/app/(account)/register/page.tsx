import type { Metadata } from 'next';
import { firstParam, safeNextPath } from '@/components/account/paths';
import { RegisterForm } from '@/components/account/RegisterForm';
import { PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.register.title') };
}

export default async function RegisterPage(props: PageProps<'/register'>) {
  const [t, query] = await Promise.all([getT(), props.searchParams]);
  return (
    <>
      <PageTitle>{t('account.register.title')}</PageTitle>
      <RegisterForm next={safeNextPath(firstParam(query.next))} />
    </>
  );
}

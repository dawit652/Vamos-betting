import type { Metadata } from 'next';
import { LoginForm } from '@/components/account/LoginForm';
import { firstParam, safeNextPath } from '@/components/account/paths';
import { PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.login.title') };
}

export default async function LoginPage(props: PageProps<'/login'>) {
  const [t, query] = await Promise.all([getT(), props.searchParams]);
  return (
    <>
      <PageTitle>{t('account.login.title')}</PageTitle>
      <LoginForm
        next={safeNextPath(firstParam(query.next))}
        passwordChanged={firstParam(query.reset) === '1'}
      />
    </>
  );
}

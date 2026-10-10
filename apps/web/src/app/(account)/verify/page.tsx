import type { Metadata } from 'next';
import { PageTitle } from '@/components/account/ui';
import { VerifyForm } from '@/components/account/VerifyForm';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.verify.title') };
}

/** Second step of registration: the SMS code (state handed over in memory by /register). */
export default async function VerifyPage() {
  const t = await getT();
  return (
    <>
      <PageTitle>{t('account.verify.title')}</PageTitle>
      <VerifyForm />
    </>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { ForgotForm } from '@/components/account/ForgotForm';
import { accountPaths } from '@/components/account/paths';
import { BackLink, PageTitle } from '@/components/account/ui';
import { getT } from '@/i18n/server';
import { routes } from '@/lib/routes';
import { telegramUrl } from '@/lib/telegram';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('account.forgot.title') };
}

export default async function ForgotPasswordPage() {
  const t = await getT();
  // Forgot PIN over Telegram (owner, 17 Nov 2026): the bot (TELEGRAM_PUBLIC_URL must be its link)
  // opens on the reset step, proves the number and sends the code; it is entered on the reset page.
  const telegram = telegramUrl();
  return (
    <>
      <PageTitle back={<BackLink href={routes.login}>{t('account.login.title')}</BackLink>}>
        {t('account.forgot.title')}
      </PageTitle>
      <ForgotForm />
      {telegram !== null ? (
        <section aria-labelledby="forgot-telegram" className="card mx-3 mt-4 space-y-3">
          <h2 id="forgot-telegram" className="font-bold">
            {t('account.forgot.telegramTitle')}
          </h2>
          <p className="text-sm text-muted">{t('account.forgot.telegramHint')}</p>
          <a
            href={`${telegram}?start=reset`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary w-full"
          >
            {t('account.forgot.telegram')}
          </a>
          <Link href={accountPaths.resetPassword} className="btn btn-outline w-full">
            {t('account.forgot.haveCode')}
          </Link>
        </section>
      ) : null}
    </>
  );
}

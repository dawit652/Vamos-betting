'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useT } from '@/i18n/client';
import { useSession } from '@/providers/SessionProvider';
import { loginHref, registerHref } from './paths';
import { Skeleton } from './ui';

/** "Log in to continue" card; `next` brings the player back here afterwards. */
export function SignInPrompt({ next }: { next?: string }) {
  const t = useT();
  const pathname = usePathname();
  const target = next ?? pathname;
  return (
    <section className="card m-3 space-y-3 text-center">
      <h1 className="text-base font-bold">{t('account.gate.title')}</h1>
      <p className="text-muted">{t('account.gate.body')}</p>
      <div className="flex justify-center gap-2">
        <Link href={loginHref(target)} className="btn btn-primary">
          {t('account.login.submit')}
        </Link>
        <Link href={registerHref(target)} className="btn btn-accent">
          {t('account.register.submit')}
        </Link>
      </div>
    </section>
  );
}

/**
 * Renders its children only for a signed-in player: a skeleton while the
 * session loads, the sign-in card when there is none. Signed-in data is
 * fetched in the browser (the session cookie belongs to the API host).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.status === 'loading') return <Skeleton />;
  if (session.status === 'anonymous') return <SignInPrompt />;
  return <>{children}</>;
}

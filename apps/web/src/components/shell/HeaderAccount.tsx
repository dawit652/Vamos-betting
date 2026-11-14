'use client';

import Link from 'next/link';
import { useT } from '@/i18n/client';
import { formatSantim } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';

/** Balance pill with a deposit shortcut when signed in; log in / register otherwise. */
export function HeaderAccount() {
  const t = useT();
  const session = useSession();

  if (session.status === 'loading') {
    return <span className="h-8 w-24 animate-pulse rounded-full bg-white/15" aria-hidden="true" />;
  }

  if (session.status === 'anonymous') {
    return (
      <>
        <Link
          href={routes.login}
          prefetch={false}
          className="flex h-8 items-center rounded-full border border-white/25 px-2.5 text-xs font-bold whitespace-nowrap sm:px-3"
        >
          {t('common.header.login')}
        </Link>
        <Link
          href={routes.register}
          prefetch={false}
          className="flex h-8 items-center rounded-full bg-accent px-2.5 text-xs font-extrabold whitespace-nowrap text-accent-ink sm:px-3"
        >
          {t('common.header.register')}
        </Link>
      </>
    );
  }

  const amount = formatSantim(session.wallet?.cash);
  return (
    <span className="flex h-8 items-center rounded-full bg-white/10 pl-3 text-xs font-bold">
      <Link
        href={routes.wallet}
        className="flex items-center gap-1 pr-2 tabular-nums"
        aria-label={t('common.header.balanceLabel', { amount: `ETB ${amount}` })}
      >
        <span className="text-xxs font-semibold opacity-70">ETB</span>
        <span>{amount}</span>
      </Link>
      <Link
        href={routes.deposit}
        prefetch={false}
        aria-label={t('common.header.deposit')}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-lg leading-none font-extrabold text-accent-ink"
      >
        +
      </Link>
    </span>
  );
}

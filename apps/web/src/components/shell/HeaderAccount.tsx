'use client';

import Link from 'next/link';
import { useT } from '@/i18n/client';
import { formatSantim } from '@/lib/format';
import { routes } from '@/lib/routes';
import { useSession } from '@/providers/SessionProvider';

/** Balance chip when signed in; log in / register links otherwise. */
export function HeaderAccount() {
  const t = useT();
  const session = useSession();

  if (session.status === 'loading') {
    return <span className="h-7 w-24 animate-pulse rounded bg-white/15" aria-hidden="true" />;
  }

  if (session.status === 'anonymous') {
    return (
      <>
        <Link
          href={routes.login}
          prefetch={false}
          className="rounded border border-white/40 px-3 py-1 text-xs font-bold"
        >
          {t('common.header.login')}
        </Link>
        <Link
          href={routes.register}
          prefetch={false}
          className="rounded bg-accent px-3 py-1 text-xs font-bold text-accent-ink"
        >
          {t('common.header.register')}
        </Link>
      </>
    );
  }

  const amount = formatSantim(session.wallet?.cash);
  return (
    <Link
      href={routes.wallet}
      className="flex items-center gap-1 rounded bg-brand-strong px-2 py-1 text-xs font-bold tabular-nums"
      aria-label={t('common.header.balanceLabel', { amount: `ETB ${amount}` })}
    >
      <span className="text-xxs font-semibold opacity-75">ETB</span>
      <span>{amount}</span>
    </Link>
  );
}

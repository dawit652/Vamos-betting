'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useT } from '@/i18n/client';
import { betsApi, type BetListStatus } from '@/lib/api/account';
import { errorMessageKey } from '@/lib/api/errors';
import { routes } from '@/lib/routes';
import { BetCard } from './BetCard';
import { Alert, Skeleton } from './ui';
import { usePagedList } from './usePagedList';

export function MyBetsList({ tab }: { tab: BetListStatus }) {
  const t = useT();
  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) => betsApi.list(tab, cursor, signal),
    [tab],
  );
  const list = usePagedList(fetchPage);

  if (list.loading) return <Skeleton lines={4} />;

  return (
    <div className="space-y-2 px-3">
      {list.error ? (
        <div className="space-y-2">
          <Alert>{t(errorMessageKey(list.error))}</Alert>
          <button
            type="button"
            className="btn btn-outline w-full"
            onClick={list.items.length === 0 ? list.reload : list.loadMore}
          >
            {t('common.actions.retry')}
          </button>
        </div>
      ) : null}
      {!list.error && list.items.length === 0 ? (
        <div className="card space-y-3 text-center">
          <p className="text-muted">
            {t(tab === 'open' ? 'account.myBets.emptyOpen' : 'account.myBets.emptySettled')}
          </p>
          <Link href={routes.home} className="btn btn-accent">
            {t('account.myBets.browse')}
          </Link>
        </div>
      ) : null}
      {list.items.map((bet) => (
        <BetCard key={bet.id} bet={bet} />
      ))}
      {list.hasMore && !list.error ? (
        <button
          type="button"
          className="btn btn-outline w-full"
          disabled={list.loadingMore}
          onClick={list.loadMore}
        >
          {list.loadingMore ? t('common.actions.loading') : t('account.myBets.loadMore')}
        </button>
      ) : null}
    </div>
  );
}

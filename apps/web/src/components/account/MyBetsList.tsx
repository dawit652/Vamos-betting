'use client';

import type { CashOutResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useT } from '@/i18n/client';
import { betsApi, type BetListStatus } from '@/lib/api/account';
import { cashOutApi } from '@/lib/api/cashout';
import { errorMessageKey } from '@/lib/api/errors';
import { mergeOffers, openBetEventIds, openBetIds } from '@/lib/cashout/offer';
import { useLiveTick } from '@/lib/cashout/useLiveTick';
import { describeUserMessage } from '@/lib/user-stream/messages';
import { useUserStream } from '@/lib/user-stream/useUserStream';
import { routes } from '@/lib/routes';
import { reconcileBet } from './bets';
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
  const { setItems, reload } = list;

  // A push message about a bet (accepted, settled, cashed out, re-opened): re-fetch that bet.
  useUserStream((message) => {
    const { betId } = describeUserMessage(message);
    if (betId === null) return;
    betsApi.get(betId).then(
      (bet) => setItems((items) => reconcileBet(items, bet, tab)),
      () => undefined,
    );
  }, reload);

  // Cash-out offers follow the live odds: on a live delta of an open bet's match, re-fetch them.
  const itemsRef = useRef(list.items);
  useEffect(() => {
    itemsRef.current = list.items;
  }, [list.items]);
  const liveEvents = useMemo(
    () => (tab === 'open' ? openBetEventIds(list.items) : []),
    [tab, list.items],
  );
  useLiveTick(liveEvents, async () => {
    const ids = openBetIds(itemsRef.current);
    if (ids.length === 0) return;
    const { items } = await cashOutApi.offers(ids);
    setItems((current) => mergeOffers(current, items));
  });
  const onCashedOut = useCallback(
    (response: CashOutResponse) => setItems((items) => reconcileBet(items, response.bet, tab)),
    [setItems, tab],
  );

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
        <BetCard key={bet.id} bet={bet} onCashedOut={onCashedOut} />
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

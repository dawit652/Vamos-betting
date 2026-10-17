'use client';

import type { JackpotEntryView } from '@vamos/contracts';
import Link from 'next/link';
import { useCallback } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { errorMessageKey } from '@/lib/api/errors';
import { jackpotsApi } from '@/lib/api/jackpots';
import { formatMoney, formatOddsMilli, formatSantim } from '@/lib/format';
import { localName } from '@/lib/localized';
import { routes } from '@/lib/routes';
import { useUserStream } from '@/lib/user-stream/useUserStream';
import { isPositiveAmount } from '../account/bets';
import { formatDateTime } from '../account/dates';
import { Alert, Chip, Row, Skeleton } from '../account/ui';
import { usePagedList } from '../account/usePagedList';
import { ENTRY_STATUS_LABEL, entryStatusTone, PICK_STATE_CLASS, pickState } from './jackpot';

/** The Jackpot tab of My Bets: the player's entries, newest first, with "load more". */
export function JackpotEntriesList() {
  const t = useT();
  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal) => jackpotsApi.myEntries(cursor, signal),
    [],
  );
  const list = usePagedList(fetchPage);
  const { refresh } = list;

  // A settled entry changes its status, games and prize: re-fetch the loaded pages quietly.
  useUserStream((message) => {
    if (message.type === 'jackpot.settled') refresh();
  }, refresh);

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
          <p className="text-muted">{t('account.jackpot.entries.empty')}</p>
          <Link href={routes.jackpot} className="btn btn-accent">
            {t('account.jackpot.entries.play')}
          </Link>
        </div>
      ) : null}
      {list.items.map((entry) => (
        <JackpotEntryCard key={entry.id} entry={entry} />
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

/** One jackpot entry: its picks per game against the results, and the money. */
export function JackpotEntryCard({ entry }: { entry: JackpotEntryView }) {
  const t = useT();
  const locale = useLocale();
  const settled = entry.status !== 'open';
  return (
    <article className="card space-y-2">
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-bold">{t(`account.jackpot.templateName.${entry.templateCode}`)}</p>
          <p className="text-xxs text-muted">
            {t('account.jackpot.entries.combinations', { count: entry.combinations })} ·{' '}
            {formatDateTime(entry.placedAt, locale)}
          </p>
        </div>
        <Chip tone={entryStatusTone(entry.status)}>{t(ENTRY_STATUS_LABEL[entry.status])}</Chip>
      </header>
      <ul className="divide-y divide-line border-y border-line">
        {entry.games.map((game) => (
          <li key={game.position} className="flex items-center justify-between gap-2 py-1.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {t('sportsbook.match.versus', {
                  home: localName(game.homeTeam, locale),
                  away: localName(game.awayTeam, locale),
                })}
              </p>
              <p className="text-xxs text-muted">
                {game.score ? `${game.score.home}-${game.score.away} · ` : ''}
                {game.result === 'cancelled'
                  ? t('account.jackpot.recent.cancelledGame')
                  : game.result !== null
                    ? `${t('account.jackpot.recent.result')}: ${game.result}`
                    : game.odds
                      ? `${formatOddsMilli(game.odds['1'])} · ${formatOddsMilli(game.odds.X)} · ${formatOddsMilli(game.odds['2'])}`
                      : formatDateTime(game.startTime, locale)}
              </p>
            </div>
            <div
              className="flex flex-none gap-1"
              aria-label={t('account.jackpot.entries.yourPicks')}
            >
              {game.picks.map((pick) => (
                <span
                  key={pick}
                  className={`inline-flex size-6 items-center justify-center rounded text-xs font-bold ${PICK_STATE_CLASS[pickState(pick, game.result)]}`}
                >
                  {pick}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <dl className="space-y-0.5 text-xs">
        <Row label={t('account.jackpot.entries.cost')}>{formatMoney(entry.cost)}</Row>
        {entry.status === 'open' ? (
          <Row label={t('account.jackpot.entries.closesAt')}>
            {formatDateTime(entry.closesAt, locale)}
          </Row>
        ) : null}
        {settled && entry.bestCorrect !== null ? (
          <Row label={t('account.jackpot.entries.best', { count: entry.bestCorrect })}>
            {entry.status === 'won' ? formatMoney(entry.prizeGross) : '–'}
          </Row>
        ) : null}
        {entry.status === 'won' && isPositiveAmount(entry.prizeTax) ? (
          <Row label={t('account.jackpot.entries.tax')}>−{formatSantim(entry.prizeTax)}</Row>
        ) : null}
        {entry.status === 'won' ? (
          <Row label={t('account.jackpot.entries.net')}>{formatMoney(entry.prizeNet)}</Row>
        ) : null}
        {entry.status === 'void' ? (
          <Row label={t('account.jackpot.entries.refunded')}>
            {formatMoney(entry.refund ?? entry.cost)}
          </Row>
        ) : null}
      </dl>
      {entry.status === 'open' && entry.roundStatus === 'closed' ? (
        <p className="text-xxs text-muted">{t('account.jackpot.entries.waiting')}</p>
      ) : null}
    </article>
  );
}

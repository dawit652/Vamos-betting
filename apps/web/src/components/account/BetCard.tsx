'use client';

import type { BetLegView, BetView } from '@vamos/contracts';
import Link from 'next/link';
import { useLocale, useT } from '@/i18n/client';
import { formatOddsMilli, formatSantim, formatTotalOdds } from '@/lib/format';
import { localName } from '@/lib/localized';
import { BET_STATUS_LABEL, LEG_STATE_LABEL, betPayout, betStatusTone, legStateTone } from './bets';
import { formatDateTime } from './dates';
import { accountPaths } from './paths';
import { Chip } from './ui';

export function BetLegLine({ leg, detailed = false }: { leg: BetLegView; detailed?: boolean }) {
  const t = useT();
  const locale = useLocale();
  return (
    <li className="flex items-start justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <p className="truncate font-semibold">
          {t('sportsbook.match.versus', {
            home: localName(leg.homeTeam, locale),
            away: localName(leg.awayTeam, locale),
          })}
        </p>
        <p className="text-xs text-muted">
          {localName(leg.marketName, locale)}:{' '}
          <span className="font-semibold text-ink">{localName(leg.selectionName, locale)}</span>
        </p>
        {detailed ? (
          <p className="text-xxs text-muted">
            {t('account.myBets.gameId', { id: leg.gameId })} ·{' '}
            {leg.live ? t('account.myBets.live') : formatDateTime(leg.startTime, locale)}
          </p>
        ) : null}
      </div>
      <div className="flex flex-none flex-col items-end gap-0.5">
        <span className="font-bold tabular-nums">{formatOddsMilli(leg.oddsMilli)}</span>
        {leg.state === 'open' ? null : (
          <Chip tone={legStateTone(leg.state)}>{t(LEG_STATE_LABEL[leg.state])}</Chip>
        )}
      </div>
    </li>
  );
}

/** One bet in the My Bets list. */
export function BetCard({ bet }: { bet: BetView }) {
  const t = useT();
  const locale = useLocale();
  const payout = betPayout(bet);
  return (
    <article className="card space-y-2">
      <header className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-bold">
            {bet.betType === 'single'
              ? t('account.myBets.single')
              : t('account.myBets.multi', { count: bet.legs.length })}
          </p>
          <p className="text-xxs text-muted">
            {t('account.myBets.betId', { id: bet.shortId })} ·{' '}
            {formatDateTime(bet.placedAt, locale)}
          </p>
        </div>
        <Chip tone={betStatusTone(bet.status)}>{t(BET_STATUS_LABEL[bet.status])}</Chip>
      </header>
      <ul className="divide-y divide-line border-y border-line">
        {bet.legs.map((leg) => (
          <BetLegLine key={leg.selectionId} leg={leg} />
        ))}
      </ul>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-muted">{t('account.myBets.stake')}</dt>
          <dd className="font-bold tabular-nums">{formatSantim(bet.stake)}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('account.myBets.totalOdds')}</dt>
          <dd className="font-bold tabular-nums">{formatTotalOdds(bet.totalOddsMilli)}</dd>
        </div>
        <div className="text-right">
          <dt className="text-muted">{t(payout.label)}</dt>
          <dd className="font-bold text-brand tabular-nums">{formatSantim(payout.amount)}</dd>
        </div>
      </dl>
      <Link
        href={accountPaths.betDetail(bet.id)}
        prefetch={false}
        className="block text-right text-xs font-semibold text-brand"
      >
        {t('account.myBets.details')} ›
      </Link>
    </article>
  );
}

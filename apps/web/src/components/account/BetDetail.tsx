'use client';

import type { BetView } from '@vamos/contracts';
import { useEffect, useState } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { betsApi } from '@/lib/api/account';
import { errorMessageKey, isApiClientError } from '@/lib/api/errors';
import { formatSantim, formatTotalOdds } from '@/lib/format';
import { BetLegLine } from './BetCard';
import {
  BET_STATUS_LABEL,
  betPayout,
  betStatusTone,
  bonusPercent,
  isPositiveAmount,
  isSettledStatus,
} from './bets';
import { formatDateTime } from './dates';
import { Alert, Chip, Row, Skeleton } from './ui';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; bet: BetView }
  | { kind: 'missing' }
  | { kind: 'error'; error: unknown };

export function BetDetail({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setState({ kind: 'loading' });
    betsApi.get(id, abort.signal).then(
      (bet) => {
        if (!abort.signal.aborted) setState({ kind: 'ready', bet });
      },
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setState(
          isApiClientError(error) && error.status === 404
            ? { kind: 'missing' }
            : { kind: 'error', error },
        );
      },
    );
    return () => abort.abort();
  }, [id, attempt]);

  if (state.kind === 'loading') return <Skeleton lines={6} />;
  if (state.kind === 'missing') {
    return (
      <div className="px-3">
        <Alert tone="info">{t('account.myBets.notFound')}</Alert>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="space-y-2 px-3">
        <Alert>{t(errorMessageKey(state.error))}</Alert>
        <button
          type="button"
          className="btn btn-outline w-full"
          onClick={() => setAttempt((n) => n + 1)}
        >
          {t('common.actions.retry')}
        </button>
      </div>
    );
  }

  const { bet } = state;
  const payout = betPayout(bet);
  const settled = isSettledStatus(bet.status);
  const bonus = bonusPercent(bet.bonusPercentBps);
  return (
    <div className="space-y-2 px-3">
      <section className="card space-y-2">
        <header className="flex items-center justify-between gap-2">
          <div>
            <p className="font-bold">
              {bet.betType === 'single'
                ? t('account.myBets.single')
                : t('account.myBets.multi', { count: bet.legs.length })}
            </p>
            <p className="text-xxs text-muted">{t('account.myBets.betId', { id: bet.shortId })}</p>
          </div>
          <Chip tone={betStatusTone(bet.status)}>{t(BET_STATUS_LABEL[bet.status])}</Chip>
        </header>
        {bet.status === 'pending_acceptance' ? (
          <Alert tone="demo">{t('account.myBets.pendingNote')}</Alert>
        ) : null}
        {bet.status === 'rejected' && bet.rejectReason ? (
          <Alert tone="info">{t('account.myBets.rejected', { reason: bet.rejectReason })}</Alert>
        ) : null}
        <ul className="divide-y divide-line border-y border-line">
          {bet.legs.map((leg) => (
            <BetLegLine key={leg.selectionId} leg={leg} detailed />
          ))}
        </ul>
        <dl className="text-xs">
          <Row label={t('account.myBets.stake')}>{formatSantim(bet.stake)}</Row>
          <Row label={t('account.myBets.totalOdds')}>{formatTotalOdds(bet.totalOddsMilli)}</Row>
          {settled ? null : (
            <>
              <Row label={t('account.myBets.grossWin')}>{formatSantim(bet.potentialGross)}</Row>
              {bonus !== '' && isPositiveAmount(bet.potentialBonus) ? (
                <Row label={t('account.myBets.bonus', { percent: bonus })}>
                  {formatSantim(bet.potentialBonus)}
                </Row>
              ) : null}
              {isPositiveAmount(bet.potentialTax) ? (
                <Row label={t('account.myBets.tax')}>-{formatSantim(bet.potentialTax)}</Row>
              ) : null}
            </>
          )}
          {settled && bet.settledGross !== null && isPositiveAmount(bet.settledTax) ? (
            <>
              <Row label={t('account.myBets.grossWin')}>{formatSantim(bet.settledGross)}</Row>
              <Row label={t('account.myBets.tax')}>-{formatSantim(bet.settledTax)}</Row>
            </>
          ) : null}
          <div className="mt-1 border-t border-line pt-1 text-sm">
            <Row label={t(payout.label)}>
              <span className="text-brand">{formatSantim(payout.amount)}</span>
            </Row>
          </div>
        </dl>
      </section>
      <section className="card text-xs">
        <dl>
          <Row label={t('account.myBets.placedAt')}>{formatDateTime(bet.placedAt, locale)}</Row>
          {bet.acceptedAt ? (
            <Row label={t('account.myBets.acceptedAt')}>
              {formatDateTime(bet.acceptedAt, locale)}
            </Row>
          ) : null}
          {bet.settledAt ? (
            <Row label={t('account.myBets.settledAt')}>{formatDateTime(bet.settledAt, locale)}</Row>
          ) : null}
        </dl>
      </section>
    </div>
  );
}

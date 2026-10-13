'use client';

import type { BetView, CashOutOfferView, CashOutResponse } from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import { cashOutApi } from '@/lib/api/cashout';
import { errorMessageKey } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import {
  cashOutState,
  classifyCashOutError,
  isWorse,
  offerHasTax,
  sameOffer,
  UNAVAILABLE_REASON_KEY,
} from '@/lib/cashout/offer';
import { formatMoney } from '@/lib/format';
import { markAnnounced, pushToast } from '@/lib/user-stream/toast-bus';
import { useSession } from '@/providers/SessionProvider';
import { createIntentKeys, isDefiniteRefusal } from '../payments/payments';
import { Alert, Row } from './ui';

/**
 * Cash out on an open bet: a button with the net amount offered, and a confirm
 * sheet with gross, winnings tax and net. The sheet sends the gross the player
 * saw; the server pays the fresh offer when it is not lower, otherwise it
 * answers `cashout_offer_changed` with the new offer, which the sheet shows
 * before asking again. Loaded only by My Bets and the bet detail.
 */

export function CashOutButton({
  bet,
  onCashedOut,
}: {
  bet: BetView;
  /** The bet came back cashed out: update the list. */
  onCashedOut: (response: CashOutResponse) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const state = cashOutState(bet);
  // An open sheet stays while its offer turns unavailable: it explains why.
  const sheet =
    open && bet.status === 'open' && bet.cashOutOffer !== null ? (
      <CashOutSheet
        bet={bet}
        liveOffer={bet.cashOutOffer}
        onClose={() => setOpen(false)}
        onCashedOut={onCashedOut}
      />
    ) : null;

  if (state.kind === 'none') return sheet;
  if (state.kind === 'unavailable') {
    return (
      <div>
        <button type="button" className="btn btn-outline w-full" disabled>
          {t('account.myBets.cashOut.unavailable')}
        </button>
        <p className="pt-1 text-xxs text-muted">{t(UNAVAILABLE_REASON_KEY[state.reason])}</p>
        {sheet}
      </div>
    );
  }
  return (
    <>
      <button type="button" className="btn btn-accent w-full" onClick={() => setOpen(true)}>
        {t('account.myBets.cashOut.button', { amount: formatMoney(state.offer.net) })}
      </button>
      {sheet}
    </>
  );
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'changed'; lower: boolean }
  | { kind: 'blocked'; key: MessageKey }
  | { kind: 'error'; key: MessageKey };

function CashOutSheet({
  bet,
  liveOffer,
  onClose,
  onCashedOut,
}: {
  bet: BetView;
  /** The bet's current offer; it follows the live odds while the sheet is open. */
  liveOffer: CashOutOfferView;
  onClose: () => void;
  onCashedOut: (response: CashOutResponse) => void;
}) {
  const t = useT();
  const { refreshWallet } = useSession();
  const [shown, setShown] = useState(liveOffer);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const keys = useRef(createIntentKeys(newIdempotencyKey, 'cashout'));
  const panelRef = useRef<HTMLDivElement>(null);
  const working = phase.kind === 'working';

  // The list refreshes offers by itself: show a new one, and say it changed.
  // (Only a newer quote counts: an offer the server just sent back in a 409 is
  // fresher than the list's until the list refreshes.)
  const seen = useRef(liveOffer.quotedAt);
  useEffect(() => {
    if (liveOffer.quotedAt === seen.current) return;
    seen.current = liveOffer.quotedAt;
    if (liveOffer.available) setPhase((p) => (p.kind === 'blocked' ? { kind: 'idle' } : p));
    if (working || !liveOffer.available || sameOffer(shown, liveOffer)) return;
    setPhase({ kind: 'changed', lower: isWorse(liveOffer, shown) });
    setShown(liveOffer);
  }, [liveOffer, shown, working]);

  useEffect(() => {
    panelRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !working) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, working]);

  async function confirm() {
    if (working) return;
    setPhase({ kind: 'working' });
    // One key per confirmation of one amount: a retry after a timeout reuses it.
    const key = keys.current.get(`${bet.id}:${shown.gross}`);
    try {
      const response = await cashOutApi.execute(bet.id, shown.gross, key);
      keys.current.clear();
      markAnnounced(bet.id);
      pushToast('account.myBets.cashOut.done', { amount: formatMoney(response.cashOut.net) });
      void refreshWallet();
      onCashedOut(response);
      onClose();
    } catch (error) {
      if (isDefiniteRefusal(error)) keys.current.clear();
      const failure = classifyCashOutError(error);
      if (failure.kind === 'changed') {
        setPhase({ kind: 'changed', lower: isWorse(failure.offer, shown) });
        setShown(failure.offer);
      } else if (failure.kind === 'unavailable') {
        setPhase({ kind: 'blocked', key: UNAVAILABLE_REASON_KEY[failure.reason] });
      } else {
        setPhase({ kind: 'error', key: errorMessageKey(failure.error) });
      }
    }
  }

  const changed = phase.kind === 'changed';
  const blocked = phase.kind === 'blocked' || !liveOffer.available;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label={t('account.myBets.cashOut.close')}
        className="absolute inset-0 bg-black/45"
        disabled={working}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cashout-title"
        tabIndex={-1}
        className="relative mx-auto w-full max-w-2xl space-y-3 rounded-t-lg bg-page p-3 shadow-2xl outline-none"
      >
        <h2 id="cashout-title" className="text-lg font-bold">
          {t('account.myBets.cashOut.sheetTitle')}
        </h2>
        <p className="text-xs text-muted">{t('account.myBets.cashOut.intro')}</p>
        <dl className="card text-sm">
          <Row label={t('account.myBets.cashOut.stake')}>{formatMoney(bet.stake)}</Row>
          <Row label={t('account.myBets.cashOut.gross')}>{formatMoney(shown.gross)}</Row>
          {offerHasTax(shown) ? (
            <Row label={t('account.myBets.cashOut.tax')}>-{formatMoney(shown.tax)}</Row>
          ) : null}
          <div className="mt-1 border-t border-line pt-1 text-base">
            <Row label={t('account.myBets.cashOut.net')}>
              <span className="text-brand">{formatMoney(shown.net)}</span>
            </Row>
          </div>
        </dl>
        {changed ? (
          <Alert tone="demo">
            {t('account.myBets.cashOut.changed')}
            {phase.lower ? ` ${t('account.myBets.cashOut.lower')}` : ''}
          </Alert>
        ) : null}
        {phase.kind === 'blocked' ? <Alert tone="info">{t(phase.key)}</Alert> : null}
        {!liveOffer.available && phase.kind !== 'blocked' && liveOffer.reason !== null ? (
          <Alert tone="info">{t(UNAVAILABLE_REASON_KEY[liveOffer.reason])}</Alert>
        ) : null}
        {phase.kind === 'error' ? <Alert>{t(phase.key)}</Alert> : null}
        <div className="flex gap-2 pb-[env(safe-area-inset-bottom)]">
          <button
            type="button"
            className="btn btn-outline flex-1"
            disabled={working}
            onClick={onClose}
          >
            {t('account.myBets.cashOut.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-accent flex-1"
            disabled={working || blocked}
            onClick={() => void confirm()}
          >
            {working
              ? t('account.myBets.cashOut.working')
              : t(
                  changed ? 'account.myBets.cashOut.confirmNew' : 'account.myBets.cashOut.confirm',
                  {
                    amount: formatMoney(shown.net),
                  },
                )}
          </button>
        </div>
      </div>
    </div>
  );
}

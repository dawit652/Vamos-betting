'use client';

import type { BookingCodeStatusResponse, PublicTicketStatusResponse } from '@vamos/contracts';
import { formatBookingCode } from '@vamos/core';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useT } from '@/i18n/client';
import { bettingApi } from '@/lib/api/betting';
import { isApiClientError } from '@/lib/api/errors';
import { ticketsApi } from '@/lib/api/tickets';
import { parseCoupon } from '@/lib/coupon';
import { formatDayMonth, formatMoney, formatTime } from '@/lib/format';

type Result =
  | { kind: 'ticket'; status: PublicTicketStatusResponse }
  | { kind: 'slip'; status: BookingCodeStatusResponse };

/**
 * Check coupon (docs/plans/guest-slips-and-staff.md, GS4): a slip ID shows whether it was sold as a
 * shop ticket, still awaits cash payment or expired; a shop ticket's number shows its state, what
 * it pays and the shop that pays it (G3). `initial` comes from `/ticket?number=` (the betslip's
 * Check coupon) and is checked at once.
 */
export function TicketCheck({ initial = '' }: { initial?: string }) {
  const t = useT();
  const locale = useLocale();
  const [number, setNumber] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checkedInitial = useRef(false);

  async function run(input: string) {
    const coupon = parseCoupon(input);
    if (coupon === null) {
      setResult(null);
      setError(t('common.ticketCheck.notFound'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(
        coupon.kind === 'slip'
          ? { kind: 'slip', status: await bettingApi.bookingCodeStatus(coupon.code) }
          : { kind: 'ticket', status: await ticketsApi.status(coupon.number) },
      );
    } catch (e) {
      setResult(null);
      setError(
        isApiClientError(e) && e.status === 404
          ? t('common.ticketCheck.notFound')
          : t('common.ticketCheck.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (checkedInitial.current || initial.trim() === '') return;
    checkedInitial.current = true;
    void run(initial);
    // Only the number the page was opened with is checked by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function check(event: FormEvent) {
    event.preventDefault();
    void run(number);
  }

  const when = (iso: string) => `${formatDayMonth(iso)} ${formatTime(iso, locale)}`;
  return (
    <div className="space-y-3" data-testid="ticket-check">
      <form className="card flex flex-wrap items-end gap-2" onSubmit={check}>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          {t('common.ticketCheck.number')}
          <input
            className="input"
            autoComplete="off"
            autoCapitalize="characters"
            maxLength={24}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            data-testid="ticket-check-number"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t('common.ticketCheck.checking') : t('common.ticketCheck.submit')}
        </button>
      </form>
      {error !== null && (
        <p className="card text-sm" role="alert" data-testid="ticket-check-error">
          {error}
        </p>
      )}
      {result?.kind === 'ticket' && <TicketResult status={result.status} />}
      {result?.kind === 'slip' && (
        <section className="card space-y-1" data-testid="ticket-check-result">
          <p className="font-bold">
            {t('common.ticketCheck.slipId', { code: formatBookingCode(result.status.code) })}
          </p>
          <p data-testid="ticket-check-state">
            {result.status.state === 'awaiting_payment'
              ? t('common.ticketCheck.slipAwaiting', { time: when(result.status.expiresAt) })
              : result.status.state === 'sold'
                ? t('common.ticketCheck.slipSold', {
                    time: when(result.status.soldAt ?? result.status.createdAt),
                  })
                : t('common.ticketCheck.slipExpired', { time: when(result.status.expiresAt) })}
          </p>
          {result.status.stake !== null && result.status.state === 'awaiting_payment' && (
            <p className="text-sm text-muted">
              {t('common.ticketCheck.slipStake', { amount: formatMoney(result.status.stake) })}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function TicketResult({ status }: { status: PublicTicketStatusResponse }) {
  const t = useT();
  const shop = `${status.shop.label} ${status.shop.name}`;
  const amount = status.amount === null ? '' : formatMoney(status.amount);
  return (
    <section className="card space-y-1" data-testid="ticket-check-result">
      <p className="font-bold">{status.number}</p>
      <p className="text-sm text-muted">{t('common.ticketCheck.soldAt', { shop })}</p>
      <p data-testid="ticket-check-state">
        {status.state === 'payable'
          ? t('common.ticketCheck.payable', { amount })
          : status.state === 'paid'
            ? t('common.ticketCheck.paid', { amount })
            : t(`common.ticketCheck.${status.state}`)}
      </p>
      {status.state === 'payable' && (
        <p className="text-sm">{t('common.ticketCheck.payableHow', { shop })}</p>
      )}
      <p className="text-xs text-muted">{t('common.ticketCheck.secret')}</p>
    </section>
  );
}

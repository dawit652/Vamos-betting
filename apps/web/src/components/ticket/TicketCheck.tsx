'use client';

import type { PublicTicketStatusResponse } from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { useT } from '@/i18n/client';
import { isApiClientError } from '@/lib/api/errors';
import { ticketsApi } from '@/lib/api/tickets';
import { formatMoney } from '@/lib/format';

/** The ticket number as typed or scanned: spaces dropped, upper case. */
function normalize(input: string): string {
  return input.replace(/\s+/g, '').toUpperCase();
}

export function TicketCheck() {
  const t = useT();
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PublicTicketStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(event: FormEvent) {
    event.preventDefault();
    const wanted = normalize(number);
    if (wanted.length < 4 || wanted.length > 20) {
      setStatus(null);
      setError(t('common.ticketCheck.notFound'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setStatus(await ticketsApi.status(wanted));
    } catch (e) {
      setStatus(null);
      setError(
        isApiClientError(e) && e.status === 404
          ? t('common.ticketCheck.notFound')
          : t('common.ticketCheck.error'),
      );
    } finally {
      setBusy(false);
    }
  }

  const shop = status === null ? '' : `${status.shop.label} ${status.shop.name}`;
  const amount = status?.amount === null || status === null ? '' : formatMoney(status.amount);
  return (
    <div className="space-y-3" data-testid="ticket-check">
      <form className="card flex flex-wrap items-end gap-2" onSubmit={(e) => void check(e)}>
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
      {status !== null && (
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
      )}
    </div>
  );
}

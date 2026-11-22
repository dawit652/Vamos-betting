'use client';

import type { LiveWithdrawalCodeResponse, WithdrawalCodeResponse } from '@vamos/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import type { Message } from '@/components/account/errors';
import { Alert } from '@/components/account/ui';
import { useLocale, useT } from '@/i18n/client';
import { api } from '@/lib/api/client';
import { formatSantim } from '@/lib/format';
import { AMOUNT_ERROR_KEY, checkAmount, paymentErrorMessage } from './payments';

/** "123456" → "123 456": easier to read out loud at the desk. */
function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

const MAX_SANTIM = '100000000';

/**
 * Cash at any Nahubet shop (docs/plans/counter-codes-and-deposit-recovery.md, G4): the player
 * chooses the amount and gets a 6-digit withdrawal code. The money is set aside at once; at the
 * desk the code alone is enough (with the player's ID). The code is shown this once; it works for
 * 24 hours, then the money comes back. A new code replaces the old one.
 */
export function CashAtShop() {
  const t = useT();
  const locale = useLocale();
  const [amount, setAmount] = useState('');
  const [issued, setIssued] = useState<WithdrawalCodeResponse | null>(null);
  const [live, setLive] = useState<LiveWithdrawalCodeResponse['live']>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    let current = true;
    api.get<LiveWithdrawalCodeResponse>('/payments/withdrawal-codes').then(
      (res) => {
        if (current) setLive(res.live);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  const when = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  const getCode = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const checked = checkAmount(amount, '1', MAX_SANTIM);
    if (!checked.ok) {
      setError({ key: AMOUNT_ERROR_KEY[checked.reason] });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<WithdrawalCodeResponse>('/payments/withdrawal-codes', {
        amount: checked.amount,
        idempotencyKey: `code-${crypto.randomUUID()}`,
      });
      setIssued(res);
      setLive(null);
      setAmount('');
    } catch (e) {
      setError(paymentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3" data-testid="cash-at-shop">
      <h2 className="font-bold">{t('account.payments.cashAtShop.title')}</h2>
      <p className="text-muted">{t('account.payments.cashAtShop.intro')}</p>
      {issued !== null ? (
        <div className="space-y-1 text-center" aria-live="polite">
          <p className="text-xxs text-muted">{t('account.payments.cashAtShop.codeLabel')}</p>
          <p
            data-testid="shop-code"
            className="font-mono text-4xl font-bold tracking-widest tabular-nums"
          >
            {spaced(issued.code)}
          </p>
          <p className="font-semibold" data-testid="shop-code-amount">
            {formatSantim(issued.amount, { currency: true })}
          </p>
          <p className="text-muted">
            {t('account.payments.cashAtShop.validUntil', { time: when(issued.expiresAt) })}
          </p>
          {issued.status === 'review' ? (
            <p className="text-sm">{t('account.payments.cashAtShop.review')}</p>
          ) : null}
        </div>
      ) : live !== null ? (
        <p className="text-sm" data-testid="live-withdrawal-code">
          {t('account.payments.cashAtShop.live', {
            amount: formatSantim(live.amount, { currency: true }),
            time: when(live.expiresAt),
          })}
        </p>
      ) : null}
      <form className="space-y-2" onSubmit={(e) => void getCode(e)}>
        <label className="block">
          <span className="text-sm">{t('account.payments.cashAtShop.amount')}</span>
          <input
            className="input w-full"
            inputMode="decimal"
            data-testid="cash-code-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
        <button
          type="submit"
          className={`btn w-full ${issued !== null || live !== null ? 'btn-outline' : 'btn-accent'}`}
          disabled={busy}
        >
          {busy
            ? t('common.actions.loading')
            : issued !== null || live !== null
              ? t('account.payments.cashAtShop.getNew')
              : t('account.payments.cashAtShop.get')}
        </button>
      </form>
    </section>
  );
}

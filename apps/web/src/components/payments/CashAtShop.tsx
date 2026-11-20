'use client';

import type { CashCodeResponse } from '@vamos/contracts';
import { useEffect, useState } from 'react';
import type { Message } from '@/components/account/errors';
import { Alert } from '@/components/account/ui';
import { useLocale, useT } from '@/i18n/client';
import { api } from '@/lib/api/client';
import { paymentErrorMessage } from './payments';

/** "123456" → "123 456": easier to read out loud at the desk. */
function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** A one-time code the player reads out at a shop's desk to withdraw cash. */
export function CashAtShop() {
  const t = useT();
  const locale = useLocale();
  const [issued, setIssued] = useState<CashCodeResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  const expiresMs = issued === null ? 0 : Date.parse(issued.expiresAt);
  const left = expiresMs - now;
  const live = issued !== null && left > 0;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const getCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<CashCodeResponse>('/payments/cash-codes');
      setNow(Date.now());
      setIssued(res);
    } catch (e) {
      setError(paymentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3">
      <h2 className="font-bold">{t('account.payments.cashAtShop.title')}</h2>
      <p className="text-muted">{t('account.payments.cashAtShop.intro')}</p>
      {live ? (
        <div className="space-y-1 text-center" aria-live="polite">
          <p className="text-xxs text-muted">{t('account.payments.cashAtShop.codeLabel')}</p>
          <p
            data-testid="shop-code"
            className="font-mono text-4xl font-bold tracking-widest tabular-nums"
          >
            {spaced(issued.code)}
          </p>
          <p className="text-muted">
            {t('account.payments.cashAtShop.validUntil', {
              time: new Date(expiresMs).toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })}
          </p>
          <p className="font-semibold tabular-nums">
            {t('account.payments.cashAtShop.remaining', { time: clock(left) })}
          </p>
        </div>
      ) : null}
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      <button
        type="button"
        className={`btn w-full ${live ? 'btn-outline' : 'btn-accent'}`}
        disabled={busy}
        onClick={() => void getCode()}
      >
        {busy
          ? t('common.actions.loading')
          : issued === null
            ? t('account.payments.cashAtShop.get')
            : t('account.payments.cashAtShop.getNew')}
      </button>
    </section>
  );
}

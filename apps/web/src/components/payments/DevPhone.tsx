'use client';

import type { DevPhonePush } from '@vamos/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatDateTime } from '@/components/account/dates';
import type { Message } from '@/components/account/errors';
import { Alert, Field } from '@/components/account/ui';
import { useLocale, useT } from '@/i18n/client';
import { isApiClientError } from '@/lib/api/errors';
import { devPhoneApi } from '@/lib/api/payments';
import { formatSantim } from '@/lib/format';
import { useSession } from '@/providers/SessionProvider';
import { PaymentDemoNotice, usePaymentOptions } from './PaymentParts';
import { DEV_PHONE_PIN_HINT, DEV_PHONE_REFRESH_MS, paymentErrorMessage } from './payments';

interface Result {
  tone: 'success' | 'error';
  message: Message;
}

function Push({ push, onDone }: { push: DevPhonePush; onDone: (result: Result) => void }) {
  const t = useT();
  const locale = useLocale();
  const { refreshWallet } = useSession();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  const decide = async (decision: 'approve' | 'decline') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await devPhoneApi.decide({
        depositId: push.depositId,
        decision,
        ...(decision === 'approve' ? { pin } : {}),
      });
      void refreshWallet();
      onDone({
        tone: 'success',
        message: {
          key:
            decision === 'approve'
              ? 'account.payments.dev.approved'
              : 'account.payments.dev.declined',
          vars: { outcome: res.outcome },
        },
      });
    } catch (e) {
      setError(paymentErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 rounded-md border border-line bg-surface p-3">
      <p className="text-base font-bold tabular-nums">
        {t('account.payments.dev.amountLine', { amount: formatSantim(push.amount) })}
      </p>
      {push.instructions ? <p className="text-muted">{push.instructions}</p> : null}
      <p className="text-xxs text-muted">
        {t('account.payments.dev.expires', { time: formatDateTime(push.expiresAt, locale) })}
      </p>
      <Field
        id={`pin-${push.depositId}`}
        label={t('account.payments.dev.pin')}
        hint={t('account.payments.dev.pinHint', { pin: DEV_PHONE_PIN_HINT })}
      >
        <input
          id={`pin-${push.depositId}`}
          className="input text-center tracking-[0.5em] tabular-nums"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
        />
      </Field>
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || pin.length === 0}
          onClick={() => void decide('approve')}
        >
          {t('account.payments.dev.approve')}
        </button>
        <button
          type="button"
          className="btn btn-outline"
          disabled={busy}
          onClick={() => void decide('decline')}
        >
          {t('account.payments.dev.decline')}
        </button>
      </div>
    </li>
  );
}

/** The signed-in player's own phone: the API shows only pushes to their registered number. */
function Phone({ phone }: { phone: string }) {
  const t = useT();
  const [pushes, setPushes] = useState<DevPhonePush[] | null>(null);
  const [error, setError] = useState<Message | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++requestId.current;
    try {
      const res = await devPhoneApi.pushes();
      if (mine !== requestId.current) return;
      setPushes(res.items);
      setError(null);
    } catch (e) {
      if (mine !== requestId.current) return;
      setError(
        isApiClientError(e) && e.status === 404
          ? { key: 'account.payments.dev.unreachable' }
          : paymentErrorMessage(e),
      );
    }
  }, []);

  // Look for requests now and every few seconds, like a phone waiting for a push.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), DEV_PHONE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="mx-auto max-w-sm space-y-3 rounded-2xl border-4 border-ink bg-page p-3">
      <p className="rounded bg-ink px-2 py-1 text-center text-xs font-bold uppercase tracking-wide text-page">
        {t('account.payments.dev.label')}
      </p>
      <p className="text-center">
        <span className="text-muted">{t('account.payments.dev.phone')}: </span>
        <span className="font-bold tabular-nums">{phone}</span>
      </p>
      <button
        type="button"
        className="btn btn-outline w-full"
        onClick={() => {
          setResult(null);
          void load();
        }}
      >
        {t('account.payments.dev.refresh')}
      </button>
      {result ? (
        <Alert tone={result.tone}>{t(result.message.key, result.message.vars)}</Alert>
      ) : null}
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      {pushes !== null && pushes.length === 0 && !error ? (
        <p className="text-center text-muted">{t('account.payments.dev.none')}</p>
      ) : null}
      {pushes !== null && pushes.length > 0 ? (
        <ul className="space-y-2">
          {pushes.map((push) => (
            <Push
              key={push.depositId}
              push={push}
              onDone={(r) => {
                setResult(r);
                void load();
              }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The demo-only phone simulator: only rendered when the API says it is a demo. */
export function DevPhonePanel() {
  const t = useT();
  const { me } = useSession();
  const { state, reload } = usePaymentOptions();
  return (
    <div className="space-y-3 px-3">
      <PaymentDemoNotice state={state} />
      {state.status === 'error' ? (
        <div className="space-y-2">
          <Alert>{t('account.payments.unavailable')}</Alert>
          <button type="button" className="btn btn-outline w-full" onClick={reload}>
            {t('common.actions.retry')}
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && !state.options.demo ? (
        <Alert tone="info">{t('account.payments.dev.notDemo')}</Alert>
      ) : null}
      {state.status === 'ready' && state.options.demo ? (
        <>
          <p className="text-muted">{t('account.payments.dev.intro')}</p>
          {me ? <Phone phone={me.phone} /> : null}
        </>
      ) : null}
    </div>
  );
}

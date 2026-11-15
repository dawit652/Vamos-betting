'use client';

import type { PaymentOptionsResponse, PaymentProviderName } from '@vamos/contracts';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/account/ui';
import { useT } from '@/i18n/client';
import { paymentsApi } from '@/lib/api/payments';

/**
 * Play-money notice on every payment screen. Hidden only once GET /payments/options
 * has answered `demo: false` (licensed mode); shown while loading or after an error.
 */
export function PaymentDemoNotice({ state }: { state: OptionsState }) {
  const t = useT();
  if (state.status === 'ready' && !state.options.demo) return null;
  return <Alert tone="demo">{t('account.payments.demoNotice')}</Alert>;
}

export type OptionsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; options: PaymentOptionsResponse };

/** GET /payments/options once per mount; `reload` retries after an error. */
export function usePaymentOptions(): { state: OptionsState; reload: () => void } {
  const [state, setState] = useState<OptionsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    paymentsApi
      .options(controller.signal)
      .then((options) => setState({ status: 'ready', options }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [attempt]);
  return {
    state,
    reload: () => {
      setState({ status: 'loading' });
      setAttempt((n) => n + 1);
    },
  };
}

/** Provider picker; a plain label when there is only one provider. */
export function ProviderField({
  id,
  providers,
  value,
  onChange,
}: {
  id: string;
  providers: readonly PaymentProviderName[];
  value: PaymentProviderName;
  onChange: (provider: PaymentProviderName) => void;
}) {
  const t = useT();
  if (providers.length <= 1) {
    return <p className="font-semibold">{t(`account.payments.providerNames.${value}`)}</p>;
  }
  return (
    <select
      id={id}
      className="input"
      value={value}
      onChange={(event) => onChange(event.target.value as PaymentProviderName)}
    >
      {providers.map((name) => (
        <option key={name} value={name}>
          {t(`account.payments.providerNames.${name}`)}
        </option>
      ))}
    </select>
  );
}

/** Registered phone, shown but not editable: payments use this number only. */
export function PhoneReadOnly({ id, phone }: { id: string; phone: string }) {
  return (
    <input id={id} className="input" value={phone} readOnly aria-readonly="true" inputMode="tel" />
  );
}

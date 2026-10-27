'use client';

import type { AddPayoutAccountResponse, PayoutAccountsResponse } from '@vamos/contracts';
import { useCallback, useEffect, useState } from 'react';
import type { Message } from '@/components/account/errors';
import { Alert, Field, Skeleton } from '@/components/account/ui';
import { useT } from '@/i18n/client';
import { paymentsApi } from '@/lib/api/payments';
import { paymentErrorMessage } from './payments';

/** The saved payout accounts (GET /payments/payout-accounts), reloadable. */
export function usePayoutAccounts(): {
  data: PayoutAccountsResponse | null;
  failed: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<PayoutAccountsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    paymentsApi
      .payoutAccounts(controller.signal)
      .then((body) => {
        setData(body);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [round]);
  return { data, failed, reload: useCallback(() => setRound((n) => n + 1), []) };
}

/**
 * "Add a bank account": in the player's own name (the API checks it against
 * the KYC name), confirmed by a code sent to the registered phone and bound
 * to this one account. Ported from Melabingo's AddBank.
 */
function AddBank({
  destinations,
  onDone,
}: {
  destinations: PayoutAccountsResponse['destinations'];
  onDone: () => void;
}) {
  const t = useT();
  const banks = destinations.filter((d) => d.accountKind === 'account');
  const [institution, setInstitution] = useState(banks[0]?.id ?? '');
  const [account, setAccount] = useState('');
  const [accountName, setAccountName] = useState('');
  const [pending, setPending] = useState<AddPayoutAccountResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);

  const run = (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    task()
      .catch((e: unknown) => setError(paymentErrorMessage(e)))
      .finally(() => setBusy(false));
  };

  if (pending !== null) {
    return (
      <form
        className="space-y-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          run(async () => {
            await paymentsApi.confirmPayoutAccount(pending.account.id, code.trim());
            onDone();
          });
        }}
      >
        <Field id="payout-code" label={t('account.payments.withdraw.code')}>
          <input
            id="payout-code"
            className="input tabular-nums"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          />
        </Field>
        {pending.otp?.demoOtp ? (
          <p className="text-xxs text-muted">
            {t('account.payments.withdraw.demoCode', { code: pending.otp.demoOtp })}
          </p>
        ) : null}
        {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
        <button
          type="submit"
          className="btn btn-accent w-full"
          disabled={busy || code.length !== 6}
        >
          {t('account.payments.withdraw.confirm')}
        </button>
        <button
          type="button"
          className="btn btn-outline w-full"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setPending(await paymentsApi.resendPayoutAccountCode(pending.account.id));
            })
          }
        >
          {t('account.payments.withdraw.resend')}
        </button>
      </form>
    );
  }

  return (
    <form
      className="space-y-2"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        run(async () => {
          const added = await paymentsApi.addPayoutAccount({
            institution,
            account: account.trim(),
            accountName: accountName.trim(),
          });
          if (added.account.verified) onDone();
          else setPending(added);
        });
      }}
    >
      <p className="text-muted">{t('account.payments.withdraw.addBankIntro')}</p>
      <Field id="payout-bank" label={t('account.payments.withdraw.bank')}>
        <select
          id="payout-bank"
          className="input"
          value={institution}
          onChange={(event) => setInstitution(event.target.value)}
        >
          {banks.map((bank) => (
            <option key={bank.id} value={bank.id}>
              {bank.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="payout-account" label={t('account.payments.withdraw.accountNumber')}>
        <input
          id="payout-account"
          className="input tabular-nums"
          inputMode="numeric"
          autoComplete="off"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
        />
      </Field>
      <Field id="payout-name" label={t('account.payments.withdraw.accountName')}>
        <input
          id="payout-name"
          className="input"
          autoComplete="name"
          value={accountName}
          onChange={(event) => setAccountName(event.target.value)}
        />
      </Field>
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      <button
        type="submit"
        className="btn btn-accent w-full"
        disabled={busy || account.trim().length < 5 || accountName.trim().length < 2}
      >
        {t('account.payments.withdraw.addSubmit')}
      </button>
    </form>
  );
}

/**
 * Where an SMS-rail withdrawal is paid: the player's saved, confirmed
 * accounts (their own phone wallet first), and adding a bank account.
 */
export function PayoutAccountPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useT();
  const { data, failed, reload } = usePayoutAccounts();
  const [adding, setAdding] = useState(false);

  const verified = data?.items.filter((a) => a.verified) ?? [];
  const firstVerified = verified[0]?.id ?? null;
  useEffect(() => {
    if (value === null && firstVerified !== null) onChange(firstVerified);
  }, [value, firstVerified, onChange]);

  if (failed) return <Alert>{t('account.payments.unavailable')}</Alert>;
  if (data === null) return <Skeleton lines={2} />;
  if (!data.canAdd && data.items.length === 0) {
    return <Alert tone="info">{t('account.payments.withdraw.noAccounts')}</Alert>;
  }
  return (
    <div className="space-y-2">
      <fieldset className="space-y-1.5">
        <legend className="font-semibold">{t('account.payments.withdraw.payTo')}</legend>
        {data.items.map((account) => (
          <label key={account.id} className="flex items-center gap-2">
            <input
              type="radio"
              name="payout-account"
              value={account.id}
              disabled={!account.verified}
              checked={value === account.id}
              onChange={() => onChange(account.id)}
            />
            <span>
              {account.kind === 'wallet'
                ? t('account.payments.withdraw.ownWallet', { phone: account.account })
                : `${account.institutionName} · ${account.account}`}
              {account.verified ? null : (
                <span className="ml-1 text-xxs text-muted">
                  ({t('account.payments.withdraw.unverified')})
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {data.canAdd ? (
        adding ? (
          <AddBank
            destinations={data.destinations}
            onDone={() => {
              setAdding(false);
              reload();
            }}
          />
        ) : (
          <button type="button" className="btn btn-outline w-full" onClick={() => setAdding(true)}>
            {t('account.payments.withdraw.addBank')}
          </button>
        )
      ) : null}
    </div>
  );
}

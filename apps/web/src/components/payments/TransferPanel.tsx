'use client';

import type { DepositView as Deposit, PaymentOptionsResponse } from '@vamos/contracts';
import { ussdHref } from '@vamos/core';
import { useState } from 'react';
import { formatDateTime } from '@/components/account/dates';
import type { Message } from '@/components/account/errors';
import { Alert, Field } from '@/components/account/ui';
import { useLocale, useT } from '@/i18n/client';
import { devSmsApi, paymentsApi } from '@/lib/api/payments';
import { formatSantim } from '@/lib/format';
import {
  DEPOSIT_CHECK_LABEL,
  clipboardAccount,
  extraSantim,
  paymentErrorMessage,
  splitSendAmount,
} from './payments';

type SmsRail = NonNullable<PaymentOptionsResponse['smsRail']>;

/** A value with a copy button (the clipboard gets `copyValue`, the screen shows `value`). */
function Copyable({
  label,
  value,
  copyValue,
}: {
  label: string;
  value: string;
  copyValue?: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xxs text-muted">{label}</p>
        <p className="font-semibold tabular-nums break-all">{value}</p>
      </div>
      <button
        type="button"
        className="btn btn-outline flex-none"
        onClick={() => {
          navigator.clipboard
            .writeText(copyValue ?? value)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied
          ? t('account.payments.deposit.transfer.copied')
          : t('account.payments.deposit.transfer.copy')}
      </button>
    </div>
  );
}

/** "Paid, but my balance has not changed?": the paste is only a lookup key. */
function DepositCheck({ onDeposit }: { onDeposit: (deposit: Deposit) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<keyof typeof DEPOSIT_CHECK_LABEL | null>(null);
  const [error, setError] = useState<Message | null>(null);
  return (
    <form
      className="space-y-2 border-t border-line pt-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || text.trim().length < 4) return;
        setBusy(true);
        setError(null);
        paymentsApi
          .checkDeposit(text.trim())
          .then((response) => {
            setResult(response.status);
            if (response.deposit !== null) onDeposit(response.deposit);
          })
          .catch((e: unknown) => setError(paymentErrorMessage(e)))
          .finally(() => setBusy(false));
      }}
    >
      <h3 className="font-bold">{t('account.payments.deposit.transfer.checkTitle')}</h3>
      <Field
        id="deposit-check"
        label={t('account.payments.deposit.transfer.checkLabel')}
        hint={t('account.payments.deposit.transfer.checkHint')}
      >
        <textarea
          id="deposit-check"
          className="input min-h-20"
          maxLength={2000}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {result !== null ? (
        <Alert tone={result === 'credited' || result === 'already_credited' ? 'success' : 'info'}>
          {t(DEPOSIT_CHECK_LABEL[result])}
        </Alert>
      ) : null}
      {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
      <button type="submit" className="btn btn-outline w-full" disabled={busy}>
        {busy ? t('common.actions.loading') : t('account.payments.deposit.transfer.checkSubmit')}
      </button>
    </form>
  );
}

/** DEV ONLY (simulated rail): play the bank and send the confirmation SMS. */
function Simulator({ deposit, onDeposit }: { deposit: Deposit; onDeposit: (d: Deposit) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;
  const send = (variant: 'exact' | 'round' | 'other_phone') => {
    setBusy(true);
    devSmsApi
      .send({ depositId: deposit.id, variant })
      .then((response) => {
        setOutcome(response.outcome);
        onDeposit(response.deposit);
      })
      .catch(() => setUnavailable(true))
      .finally(() => setBusy(false));
  };
  return (
    <div className="space-y-2 rounded border border-dashed border-line p-3">
      <h3 className="font-bold">{t('account.payments.deposit.transfer.simulateTitle')}</h3>
      <p className="text-xxs text-muted">{t('account.payments.deposit.transfer.simulateHint')}</p>
      <div className="grid gap-2">
        <button
          type="button"
          className="btn btn-accent"
          disabled={busy}
          onClick={() => send('exact')}
        >
          {t('account.payments.deposit.transfer.simulateExact')}
        </button>
        <button
          type="button"
          className="btn btn-outline"
          disabled={busy}
          onClick={() => send('round')}
        >
          {t('account.payments.deposit.transfer.simulateRound')}
        </button>
        <button
          type="button"
          className="btn btn-outline"
          disabled={busy}
          onClick={() => send('other_phone')}
        >
          {t('account.payments.deposit.transfer.simulateOther')}
        </button>
      </div>
      {outcome !== null ? (
        <p className="text-xxs text-muted">
          {t('account.payments.deposit.transfer.simulated', { outcome })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * How to pay an SMS-rail deposit: the exact amount (its last santim are the
 * reference), the collection account with copy buttons and the USSD code,
 * the steps, the player's own check, and the simulator in the demo.
 * Ported from Melabingo's DepositMethods.
 */
export function TransferPanel({
  deposit,
  rail,
  demo,
  onDeposit,
}: {
  deposit: Deposit;
  rail: SmsRail;
  demo: boolean;
  onDeposit: (deposit: Deposit) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState(0);
  const transfer = deposit.transfer;
  if (transfer === null) return null;
  const method = rail.methods[selected] ?? rail.methods[0];
  const { birr, santim } = splitSendAmount(transfer.sendAmount);
  const amountText = formatSantim(transfer.sendAmount);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="font-bold">
          {t('account.payments.deposit.transfer.title', { amount: amountText })}
        </p>
        <p className="text-2xl font-bold tabular-nums" aria-hidden="true">
          ETB {birr}.<span className="rounded bg-accent px-1 text-ink">{santim}</span>
        </p>
        <p className="text-muted">
          {t('account.payments.deposit.transfer.whyExact', { santim: extraSantim(transfer) })}
        </p>
        <Copyable
          label={t('account.payments.deposit.transfer.copyAmount')}
          value={`ETB ${amountText}`}
          copyValue={amountText.replace(/,/g, '')}
        />
      </div>

      {rail.methods.length > 1 ? (
        <div
          role="tablist"
          aria-label={t('account.payments.deposit.transfer.payWith')}
          className="flex gap-2"
        >
          {rail.methods.map((m, index) => (
            <button
              key={m.institution}
              type="button"
              role="tab"
              aria-selected={index === selected}
              className={`chip ${index === selected ? 'border-brand bg-brand text-brand-ink' : ''}`}
              onClick={() => setSelected(index)}
            >
              {m.name}
            </button>
          ))}
        </div>
      ) : null}

      {method ? (
        <div className="card space-y-2">
          <p className="text-xxs font-semibold uppercase text-muted">
            {t('account.payments.deposit.transfer.sendTo')} · {method.name}
          </p>
          {method.accounts.map((account) => (
            <div key={account.account} className="space-y-1">
              <Copyable
                label={t('account.payments.deposit.transfer.account')}
                value={account.account}
                copyValue={clipboardAccount(account.account)}
              />
              <p className="text-xxs text-muted">
                {t('account.payments.deposit.transfer.holder')}: {account.name}
              </p>
              {account.hint ? <p className="text-xxs text-muted">{account.hint}</p> : null}
            </div>
          ))}
          {method.ussd !== null ? (
            <a href={ussdHref(method.ussd)} className="btn btn-accent w-full">
              {t('account.payments.deposit.transfer.dial', { code: method.ussd })}
            </a>
          ) : null}
          {method.appName !== null ? (
            <p className="text-center text-xxs text-muted">
              {t('account.payments.deposit.transfer.app', { app: method.appName })}
            </p>
          ) : null}
          {method.kind === 'bank' ? (
            <p className="text-xxs text-muted">{t('account.payments.deposit.transfer.anyBank')}</p>
          ) : null}
        </div>
      ) : null}

      <ol className="list-decimal space-y-1 pl-5">
        <li>{t('account.payments.deposit.transfer.step1')}</li>
        <li>{t('account.payments.deposit.transfer.step2', { amount: amountText })}</li>
        <li>{t('account.payments.deposit.transfer.step3')}</li>
      </ol>
      <p className="text-xxs text-muted">
        {t('account.payments.deposit.transfer.expires', {
          time: formatDateTime(deposit.expiresAt, locale),
        })}
      </p>

      {demo && rail.mode === 'simulated' ? (
        <Simulator deposit={deposit} onDeposit={onDeposit} />
      ) : null}
      <DepositCheck onDeposit={onDeposit} />
    </div>
  );
}

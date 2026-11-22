'use client';

import type {
  CreateDepositClaimRequest,
  DepositClaimListResponse,
  DepositClaimMethod,
  DepositClaimResponse,
  DepositClaimView,
} from '@vamos/contracts';
import type { MessageKey } from '@vamos/i18n/translate';
import { useEffect, useState, type FormEvent } from 'react';
import { formatDateTime } from '@/components/account/dates';
import type { Message } from '@/components/account/errors';
import { Alert } from '@/components/account/ui';
import { useLocale, useT } from '@/i18n/client';
import { api } from '@/lib/api/client';
import { isApiClientError } from '@/lib/api/errors';
import { formatSantim } from '@/lib/format';
import { checkAmount, paymentErrorMessage } from './payments';

/**
 * "My deposit did not arrive" (docs/plans/counter-codes-and-deposit-recovery.md, G5.3): the
 * player reports a payment that is not in their balance. Nothing is credited from this form: the
 * back office checks it against the money that arrived.
 */

const METHODS: readonly DepositClaimMethod[] = ['telebirr', 'cbe', 'chapa', 'other'];
const MAX_SANTIM = '100000000';

const CLAIM_ERRORS: Readonly<Record<string, MessageKey>> = {
  claim_exists: 'account.payments.depositClaim.errors.exists',
  too_many_open_claims: 'account.payments.depositClaim.errors.tooMany',
  claim_too_old: 'account.payments.depositClaim.errors.tooOld',
  claim_time_invalid: 'account.payments.depositClaim.errors.time',
  claim_reference_invalid: 'account.payments.depositClaim.errors.reference',
  claim_phone_invalid: 'account.payments.depositClaim.errors.phone',
};

function claimError(error: unknown): Message {
  if (isApiClientError(error)) {
    const key = CLAIM_ERRORS[error.code];
    if (key !== undefined) return { key };
  }
  return paymentErrorMessage(error);
}

/** "2026-11-22T14:05" for a datetime-local input, in the device's time. */
function localInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function DepositClaim() {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [claims, setClaims] = useState<readonly DepositClaimView[]>([]);
  const [method, setMethod] = useState<DepositClaimMethod>('telebirr');
  const [amount, setAmount] = useState('');
  const [paidAt, setPaidAt] = useState(() => localInput(new Date()));
  const [reference, setReference] = useState('');
  const [payerPhone, setPayerPhone] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<DepositClaimListResponse>('/payments/deposit-claims').then(
      (res) => {
        if (live) setClaims(res.claims);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const checked = checkAmount(amount, '1', MAX_SANTIM);
    if (!checked.ok) {
      setError({ key: 'account.payments.amountInvalid' });
      return;
    }
    const when = new Date(paidAt);
    if (Number.isNaN(when.getTime())) {
      setError({ key: 'account.payments.depositClaim.errors.time' });
      return;
    }
    const body: CreateDepositClaimRequest = {
      method,
      amount: checked.amount,
      paidAt: when.toISOString(),
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(payerPhone.trim() ? { payerPhone: payerPhone.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<DepositClaimResponse>('/payments/deposit-claims', body);
      setClaims((current) => [res.claim, ...current]);
      setSent(true);
      setAmount('');
      setReference('');
      setPayerPhone('');
      setNote('');
    } catch (e) {
      setError(claimError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3" data-testid="deposit-claim">
      <button
        type="button"
        className="w-full text-left font-bold"
        aria-expanded={open}
        data-testid="deposit-claim-toggle"
        onClick={() => setOpen((value) => !value)}
      >
        {t('account.payments.depositClaim.title')}
      </button>
      {open ? (
        <form className="space-y-3" onSubmit={(e) => void submit(e)}>
          <p className="text-muted">{t('account.payments.depositClaim.intro')}</p>
          <label className="block">
            <span className="text-sm">{t('account.payments.depositClaim.method')}</span>
            <select
              className="input w-full"
              data-testid="deposit-claim-method"
              value={method}
              onChange={(e) => setMethod(e.target.value as DepositClaimMethod)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {t(`account.payments.depositClaim.methods.${m}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm">{t('account.payments.depositClaim.amount')}</span>
            <input
              className="input w-full"
              inputMode="decimal"
              data-testid="deposit-claim-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm">{t('account.payments.depositClaim.paidAt')}</span>
            <input
              className="input w-full"
              type="datetime-local"
              data-testid="deposit-claim-paid-at"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm">{t('account.payments.depositClaim.reference')}</span>
            <input
              className="input w-full"
              autoComplete="off"
              data-testid="deposit-claim-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
            <span className="text-xxs text-muted">
              {t('account.payments.depositClaim.referenceHint')}
            </span>
          </label>
          <label className="block">
            <span className="text-sm">{t('account.payments.depositClaim.payerPhone')}</span>
            <input
              className="input w-full"
              inputMode="tel"
              value={payerPhone}
              onChange={(e) => setPayerPhone(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm">{t('account.payments.depositClaim.note')}</span>
            <input
              className="input w-full"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {error ? <Alert>{t(error.key, error.vars)}</Alert> : null}
          {sent ? (
            <p role="status" className="text-sm" data-testid="deposit-claim-sent">
              {t('account.payments.depositClaim.sent')}
            </p>
          ) : null}
          <button
            type="submit"
            className="btn btn-accent w-full"
            disabled={busy}
            data-testid="deposit-claim-submit"
          >
            {busy ? t('common.actions.loading') : t('account.payments.depositClaim.submit')}
          </button>
        </form>
      ) : null}
      {claims.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t('account.payments.depositClaim.listTitle')}</h3>
          <ul className="space-y-1 text-sm" data-testid="deposit-claim-list">
            {claims.map((claim) => (
              <li key={claim.id} className="flex justify-between gap-2">
                <span>
                  {formatSantim(claim.amount, { currency: true })} ·{' '}
                  {formatDateTime(claim.paidAt, locale)}
                </span>
                <span data-testid="deposit-claim-status">
                  {t(`account.payments.depositClaim.status.${claim.status}` as MessageKey)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

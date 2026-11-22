'use client';

import type {
  ManualDepositRequest,
  ManualDepositResponse,
  RecheckDepositResponse,
} from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { ActionButton, Field, Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatEtb, parseEtbToSantim } from '@/lib/format';

/**
 * A deposit that reached Nahubet but was not credited, credited by one admin (owner's decision O5
 * of 21 Nov 2026; docs/plans/counter-codes-and-deposit-recovery.md, G5.2). With `intentId` the
 * player's own deposit is credited at its amount; without, the amount that arrived is typed.
 * The provider's transaction id can be used once; the owner is told above ETB 5,000.
 */
export function ManualDepositForm({
  userId,
  intent,
  onDone,
}: {
  userId: string;
  intent?: { id: string; provider: string; amount: string };
  onDone: () => void;
}) {
  const [provider, setProvider] = useState<ManualDepositRequest['provider']>(
    (intent?.provider as ManualDepositRequest['provider'] | undefined) ?? 'telebirr',
  );
  const [transactionId, setTransactionId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const santim = intent === undefined ? parseEtbToSantim(amount) : null;
    if (intent === undefined && santim === null) {
      setError('Enter the amount that arrived, in ETB.');
      return;
    }
    const body: ManualDepositRequest = {
      provider,
      providerTransactionId: transactionId,
      reason,
      ...(intent === undefined ? { amount: santim! } : { intentId: intent.id }),
    };
    if (!window.confirm('Credit this deposit to the player? It cannot be undone here.')) return;
    setBusy(true);
    try {
      const res = await api<ManualDepositResponse>(`/admin/users/${userId}/manual-deposits`, {
        method: 'POST',
        body,
      });
      setDone(`Credited ${formatEtb(res.deposit.amount)} (${res.deposit.provider}).`);
      setTransactionId('');
      setAmount('');
      setReason('');
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={(e) => void submit(e)} data-testid="manual-deposit-form">
      <p className="muted small">
        Only for money that reached our account and was not credited. Check the payment first (the
        provider&apos;s statement or the bank SMS). The transaction id can be used once; above ETB
        5,000 the owner is told.
      </p>
      {intent === undefined ? (
        <>
          <Field label="Provider">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ManualDepositRequest['provider'])}
            >
              <option value="telebirr">telebirr</option>
              <option value="chapa">Chapa</option>
              <option value="sms">Bank transfer (SMS rail)</option>
            </select>
          </Field>
          <Field label="Amount that arrived (ETB)">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
        </>
      ) : (
        <p>
          Deposit of {formatEtb(intent.amount)} via {intent.provider}
        </p>
      )}
      <Field label="Provider's transaction id">
        <input value={transactionId} onChange={(e) => setTransactionId(e.target.value)} />
      </Field>
      <Field label="Reason (who checked what)">
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Crediting…' : 'Credit deposit'}
      </button>
      {error !== null && <Notice kind="error">{error}</Notice>}
      {done !== null && <Notice kind="ok">{done}</Notice>}
    </form>
  );
}

/** Asks the provider now about a deposit not yet credited (it is credited if confirmed). */
export function RecheckDepositButton({
  intentId,
  onDone,
}: {
  intentId: string;
  onDone: () => void;
}) {
  const [result, setResult] = useState<string | null>(null);
  return (
    <span>
      <ActionButton
        label="Re-check"
        onAction={async () => {
          const res = await api<RecheckDepositResponse>(`/admin/deposits/${intentId}/recheck`, {
            method: 'POST',
            body: {},
          });
          setResult(res.outcome);
          onDone();
        }}
      />
      {result !== null && <span className="muted small"> {result}</span>}
    </span>
  );
}

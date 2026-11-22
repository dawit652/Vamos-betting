'use client';

import type {
  MoneyNotCreditedClaimView,
  MoneyNotCreditedItemView,
  MoneyNotCreditedResponse,
  MoneySuggestionReason,
  MoneySuggestionView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, Loading, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, humanize } from '@/lib/format';

/**
 * "Money not credited" (docs/plans/counter-codes-and-deposit-recovery.md, G6 and G5.3): money that
 * arrived but was not credited, and the players' claims, each with the players it may belong to.
 * Nothing is credited automatically: an admin checks and credits in one step (the SMS credit, or
 * a manual deposit), which also answers the player's claim, or closes a claim with a note.
 */

const REASON_LABELS: Record<MoneySuggestionReason, string> = {
  flagged_deposit: 'its deposit was flagged',
  own_deposit: 'their own deposit',
  payer_phone: 'the payer’s phone is theirs',
  near_deposit: 'opened a deposit of a near amount the day before',
  claim_reference: 'their claim has the same reference',
  claim_amount: 'their claim has a near amount the same day',
};

function Who({ userId, phone, name }: { userId: string; phone: string; name: string | null }) {
  return (
    <Link href={`/users/${userId}`}>
      {phone}
      {name ? ` · ${name}` : ''}
    </Link>
  );
}

/** Credits an incoming SMS to a suggested player (and answers their claim when it pairs). */
function CreditSms({
  item,
  suggestion,
  onDone,
}: {
  item: MoneyNotCreditedItemView;
  suggestion: MoneySuggestionView;
  onDone: () => void;
}) {
  return (
    <ReasonAction
      label="Credit to this player"
      submitLabel={`Credit ${formatEtb(item.amount)}`}
      prompt="Why this player (what you checked)"
      onSubmit={async (note) => {
        await api(`/admin/sms/${item.id}/credit`, {
          method: 'POST',
          body: {
            userId: suggestion.userId,
            note,
            ...(suggestion.claimId ? { claimId: suggestion.claimId } : {}),
          },
        });
        onDone();
      }}
    />
  );
}

/** A manual deposit (one admin, O5): a flagged provider deposit, or a claim with no SMS. */
function ManualCredit({
  userId,
  intentId,
  claimId,
  provider: initialProvider,
  amount,
  reference,
  onDone,
}: {
  userId: string;
  intentId?: string;
  claimId?: string;
  provider: 'chapa' | 'telebirr' | 'sms';
  amount: string;
  reference: string | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(initialProvider);
  const [transactionId, setTransactionId] = useState(reference ?? '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} data-testid="money-manual-credit">
        Credit by hand
      </button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/users/${userId}/manual-deposits`, {
        method: 'POST',
        body: {
          provider,
          providerTransactionId: transactionId.trim(),
          reason: reason.trim(),
          ...(intentId ? { intentId } : { amount }),
          ...(claimId ? { claimId } : {}),
        },
      });
      setOpen(false);
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(event) => void submit(event)}>
      {intentId ? null : (
        <select
          aria-label="Provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
        >
          <option value="sms">Transfer (SMS rail)</option>
          <option value="telebirr">telebirr</option>
          <option value="chapa">Chapa</option>
        </select>
      )}
      <input
        aria-label="Provider's transaction id"
        placeholder="Provider's transaction id"
        value={transactionId}
        onChange={(e) => setTransactionId(e.target.value)}
      />
      <input
        aria-label="Reason"
        placeholder="What you checked"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button type="submit" className="primary" disabled={busy}>
        Credit {formatEtb(amount)}
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error ? <span className="error">{error}</span> : null}
    </form>
  );
}

function Item({ item, onDone }: { item: MoneyNotCreditedItemView; onDone: () => void }) {
  const { can } = useSession();
  return (
    <section className="panel" data-testid="money-item">
      <p>
        <strong>{formatEtb(item.amount)}</strong> · {item.source} · {formatDateTime(item.at)} ·{' '}
        <Badge value={humanize(item.status)} tone={item.status === 'flagged' ? 'bad' : 'warn'} />
      </p>
      <p className="muted small">
        Reference {item.reference ?? '–'}
        {item.payerPhone ? ` · payer ${item.payerPhone}` : ''}
        {item.payerName ? ` (${item.payerName})` : ''}
        {item.reason ? ` · ${item.reason}` : ''}
      </p>
      {item.suggestions.length === 0 ? (
        <p className="muted">
          No player suggested: find the payer in Players, then credit from the SMS rail.
        </p>
      ) : (
        <ul>
          {item.suggestions.map((s) => (
            <li key={s.userId} data-testid="money-suggestion">
              <Who userId={s.userId} phone={s.phone} name={s.name} />:{' '}
              {s.reasons.map((r) => REASON_LABELS[r]).join('; ')}{' '}
              {item.kind === 'sms' && can('sms.review') ? (
                <CreditSms item={item} suggestion={s} onDone={onDone} />
              ) : null}
              {item.kind === 'provider' && can('deposits.credit') ? (
                <ManualCredit
                  userId={s.userId}
                  intentId={item.id}
                  {...(s.claimId ? { claimId: s.claimId } : {})}
                  provider={item.source === 'chapa' ? 'chapa' : 'telebirr'}
                  amount={item.amount}
                  reference={item.reference}
                  onDone={onDone}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Claim({ claim, onDone }: { claim: MoneyNotCreditedClaimView; onDone: () => void }) {
  const { can } = useSession();
  return (
    <section className="panel" data-testid="money-claim">
      <p>
        <Who userId={claim.userId} phone={claim.phone} name={claim.name} /> says they sent{' '}
        <strong>{formatEtb(claim.amount)}</strong> by {claim.method} on{' '}
        {formatDateTime(claim.paidAt)}
      </p>
      <p className="muted small">
        Reference {claim.reference ?? '–'}
        {claim.payerPhone ? ` · paid from ${claim.payerPhone}` : ''}
        {claim.note ? ` · “${claim.note}”` : ''} · filed {formatDateTime(claim.createdAt)}
      </p>
      <p>
        {claim.pairs.length === 0
          ? 'No money found for it yet.'
          : `Pairs with ${claim.pairs.length} payment(s) above (${claim.pairs
              .map((p) => REASON_LABELS[p.reason])
              .join('; ')}).`}
      </p>
      <div className="row">
        {can('deposits.credit') ? (
          <ManualCredit
            userId={claim.userId}
            claimId={claim.id}
            provider={claim.method === 'chapa' ? 'chapa' : 'sms'}
            amount={claim.amount}
            reference={claim.reference}
            onDone={onDone}
          />
        ) : null}
        {can('sms.review') ? (
          <ReasonAction
            label="Close"
            submitLabel="Close the claim"
            prompt="Why (the player is not told this note)"
            onSubmit={async (note) => {
              await api(`/admin/deposit-claims/${claim.id}/close`, {
                method: 'POST',
                body: { note },
              });
              onDone();
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

export default function MoneyNotCreditedPage() {
  const view = useFetch<MoneyNotCreditedResponse>('/admin/money-not-credited');
  const data = view.data;
  return (
    <>
      <PageHeader title="Money not credited" />
      <Loading loading={view.loading && data === null} error={view.error} />
      {data === null ? null : (
        <div data-testid="money-page">
          <p data-testid="money-waiting">
            {data.waiting.count === 0
              ? 'No money waits to be credited.'
              : `${data.waiting.count} payment(s) wait: ${formatEtb(data.waiting.amount)}, the oldest from ${formatDateTime(data.waiting.oldestAt!)}.`}{' '}
            Nothing here is credited automatically.
          </p>
          <h2>Money that arrived</h2>
          {data.items.length === 0 ? <p className="muted">None.</p> : null}
          {data.items.map((item) => (
            <Item key={`${item.kind}-${item.id}`} item={item} onDone={view.reload} />
          ))}
          <h2>Players’ claims</h2>
          {data.claims.length === 0 ? <p className="muted">None open.</p> : null}
          {data.claims.map((claim) => (
            <Claim key={claim.id} claim={claim} onDone={view.reload} />
          ))}
        </div>
      )}
    </>
  );
}

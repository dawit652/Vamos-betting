'use client';

import type { StaffWithdrawalListResponse, StaffWithdrawalView } from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { ActionButton, Badge, Loading, Notice, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';

/**
 * Record the payout as sent: the outgoing SMS proposed for it (one tap, the
 * reference then comes from the institution) or the reference the banking
 * app showed. Bank payouts need the holder-name confirmation.
 */
function SettleForm({ w, onDone }: { w: StaffWithdrawalView; onDone: () => void }) {
  const [reference, setReference] = useState('');
  const [holder, setHolder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bank = w.destination?.kind === 'bank';
  const settle = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/manual-payouts/${w.id}/settle`, {
        method: 'POST',
        body: { holderNameConfirmed: holder, ...body },
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="inline-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void settle({ reference: reference.trim() });
      }}
    >
      {bank && (
        <label className="small">
          <input type="checkbox" checked={holder} onChange={(e) => setHolder(e.target.checked)} />{' '}
          The bank showed {w.destination?.name} as the account holder
        </label>
      )}
      {w.proposedSms !== null && (
        <button
          type="button"
          className="primary"
          disabled={busy || (bank && !holder)}
          onClick={() => void settle({ smsId: w.proposedSms?.id })}
        >
          Settle with SMS {w.proposedSms.reference}
        </button>
      )}
      <input
        aria-label="Transfer reference"
        placeholder="Transfer reference"
        value={reference}
        maxLength={40}
        onChange={(e) => setReference(e.target.value)}
      />
      <button type="submit" disabled={busy || reference.trim().length < 6 || (bank && !holder)}>
        Mark paid
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

function PayoutRow({ w, reload }: { w: StaffWithdrawalView; reload: () => void }) {
  const { staff } = useSession();
  const mine = w.payingBy !== null && w.payingBy === staff?.id;
  const approvedByMe = w.approvedBy !== null && w.approvedBy === staff?.id;
  const act = async (path: string, body?: unknown) => {
    await api(`/admin/manual-payouts/${w.id}/${path}`, { method: 'POST', body: body ?? {} });
    reload();
  };
  return (
    <tr data-testid={`manual-payout-${w.id}`}>
      <td>{formatDateTime(w.approvedAt)}</td>
      <td>
        {w.player.phone}
        <div className="muted small">{w.recipientName}</div>
      </td>
      <td className="num">{formatEtb(w.amount)}</td>
      <td>
        {w.destination === null ? (
          '–'
        ) : (
          <>
            {w.destination.institutionName}
            <div>
              <strong>{w.destination.account}</strong>
            </div>
            <div className="muted small">{w.destination.name}</div>
          </>
        )}
      </td>
      <td>
        <Badge value={w.status} />
        {w.payingBy !== null && (
          <div className="muted small">
            {mine ? 'claimed by you' : 'claimed by another operator'}
          </div>
        )}
        {w.proposedSms !== null && (
          <div className="muted small">outgoing SMS {w.proposedSms.reference}</div>
        )}
      </td>
      <td>
        <div className="actions">
          {w.status === 'approved' &&
            (approvedByMe ? (
              <span className="muted small">You approved it: another operator must pay it.</span>
            ) : (
              <ActionButton label="Claim to pay" primary onAction={() => act('claim')} />
            ))}
          {w.status === 'processing' && mine && (
            <>
              <SettleForm w={w} onDone={reload} />
              <ReasonAction
                label="Release unpaid"
                prompt="Note"
                onSubmit={(note) => act('release', { note })}
              />
              <ReasonAction
                label="Transfer failed"
                danger
                onSubmit={(reason) => act('fail', { reason })}
              />
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Manual payouts (SMS rail): approved withdrawals an operator sends by hand
 * from a collection account. Claim one before sending (so nobody else sends
 * it too), send exactly the amount to the destination shown, then settle it.
 * The person who approved a withdrawal can never pay it.
 */
export default function ManualPayoutsPage() {
  const { data, error, loading, reload } =
    useFetch<StaffWithdrawalListResponse>('/admin/manual-payouts');
  return (
    <>
      <PageHeader title="Manual payouts" />
      <p className="muted">
        Claim a payout, send exactly the amount from the collection account to the destination
        shown, then settle it with the outgoing SMS or the transfer reference.
      </p>
      <Loading loading={loading && data === null} error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Approved</th>
              <th>Player</th>
              <th className="num">Amount</th>
              <th>Send to</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.items.map((w) => (
              <PayoutRow key={w.id} w={w} reload={reload} />
            ))}
          </tbody>
        </table>
      </div>
      {data !== null && data.items.length === 0 && <p className="muted">Nothing to pay.</p>}
    </>
  );
}

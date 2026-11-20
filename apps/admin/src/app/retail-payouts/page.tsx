'use client';

import type { RetailPayoutListResponse } from '@vamos/contracts';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';

type Waiting = RetailPayoutListResponse['payouts'][number];

/** One waiting shop-ticket payout: above the agent's limit, so an admin decides (four eyes). */
function Row({ payout, reload }: { payout: Waiting; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'refuse') => {
    const verb = decision === 'approve' ? 'Approve' : 'Refuse';
    if (
      !window.confirm(`${verb} the payout of ${formatEtb(payout.amount)} for ${payout.number}?`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/retail-payouts/${payout.ticketId}/${decision}`, {
        method: 'POST',
        body: {},
      });
      reload();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr data-testid="retail-payout-row">
      <td>{payout.number}</td>
      <td className="num">{formatEtb(payout.amount)}</td>
      <td>{formatDateTime(payout.requestedAt)}</td>
      <td>
        <div className="actions">
          <button
            type="button"
            className="primary"
            data-testid="retail-payout-approve"
            disabled={busy}
            onClick={() => void decide('approve')}
          >
            Approve
          </button>
          <button
            type="button"
            data-testid="retail-payout-refuse"
            disabled={busy}
            onClick={() => void decide('refuse')}
          >
            Refuse
          </button>
        </div>
        {error !== null && <Notice>{error}</Notice>}
      </td>
    </tr>
  );
}

export default function RetailPayoutsPage() {
  const list = useFetch<RetailPayoutListResponse>('/admin/retail-payouts');
  const payouts = list.data?.payouts ?? [];
  return (
    <div data-testid="retail-payouts-page">
      <PageHeader title="Ticket payouts" />
      <p className="muted">
        Shop tickets whose prize is above the agent&apos;s limit wait here. The cashier who asked
        cannot approve their own request.
      </p>
      <Loading loading={list.loading && list.data === null} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Ticket</th>
              <th className="num">Amount</th>
              <th>Requested</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <Row key={p.ticketId} payout={p} reload={list.reload} />
            ))}
            {list.data !== null && payouts.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No payouts waiting.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

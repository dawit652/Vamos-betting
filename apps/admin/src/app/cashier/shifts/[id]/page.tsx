'use client';

import type { CashierShiftDetailResponse, CashierShiftView } from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, DefList, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { hasVariance, receiptPath, varianceLabel } from '@/lib/cashier';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, parseEtbToSantim } from '@/lib/format';

/** A supervisor closes a shift its cashier left open, with the cash they counted in that drawer. */
function ForceClose({ shift, onDone }: { shift: CashierShiftView; onDone: () => void }) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const santim = parseEtbToSantim(counted);
    if (santim === null) return setError('Enter the counted cash in ETB.');
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/cashier/shifts/${shift.id}/force-close`, {
        method: 'POST',
        body: { countedCash: santim, ...(note.trim() === '' ? {} : { note: note.trim() }) },
      });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <strong>Close this shift for {shift.staffName}</strong>
      <input
        aria-label="Counted cash in the drawer (ETB)"
        placeholder="Counted cash (ETB)"
        inputMode="decimal"
        value={counted}
        onChange={(e) => setCounted(e.target.value)}
      />
      <input
        aria-label="Why"
        placeholder="Why (e.g. the cashier went home)"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="submit" disabled={busy || counted.trim() === ''}>
        Close shift (supervisor)
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

export default function CashShiftPage() {
  const { id } = useParams<{ id: string }>();
  const { can, staff } = useSession();
  const { data, error, loading, reload } = useFetch<CashierShiftDetailResponse>(
    `/admin/cashier/shifts/${id}`,
  );
  if (data === null) return <Loading loading={loading} error={error} />;
  const { shift, operations } = data;
  return (
    <>
      <PageHeader title={`Shift at ${shift.shopName}`}>
        <Link href={`/cashier/shifts/${shift.id}/report`} target="_blank">
          Shift report
        </Link>
      </PageHeader>
      <DefList
        rows={[
          ['Staff', shift.staffName],
          ['Status', <Badge key="s" value={shift.status} />],
          ['Opened', formatDateTime(shift.openedAt)],
          ['Closed', formatDateTime(shift.closedAt)],
          ['Opening float', formatEtb(shift.openingFloat)],
          ['Deposits', `${shift.deposits.count} · ${formatEtb(shift.deposits.total)}`],
          ['Withdrawals', `${shift.withdrawals.count} · ${formatEtb(shift.withdrawals.total)}`],
          ['Expected cash', formatEtb(shift.expectedCash)],
          ['Counted cash', formatEtb(shift.countedCash)],
          [
            'Variance',
            <span key="v" className={hasVariance(shift.variance) ? 'variance-bad' : undefined}>
              {formatEtb(shift.variance)} ({varianceLabel(shift.variance)})
            </span>,
          ],
          ['Note', shift.closeNote ?? '–'],
        ]}
      />
      {shift.status === 'open' &&
        can('cashier.desk') &&
        can('cashier.reports') &&
        staff?.id !== shift.staffId && <ForceClose shift={shift} onDone={reload} />}
      <h2>Receipts</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Receipt</th>
              <th>Kind</th>
              <th className="num">Amount</th>
              <th>Player</th>
              <th className="num">Copies</th>
            </tr>
          </thead>
          <tbody>
            {operations.map((op) => (
              <tr key={op.id}>
                <td>{formatDateTime(op.createdAt)}</td>
                <td>
                  {can('cashier.desk') ? (
                    <Link href={receiptPath(op.id)}>{op.reference}</Link>
                  ) : (
                    op.reference
                  )}
                </td>
                <td>{op.kind}</td>
                <td className="num">{formatEtb(op.amount)}</td>
                <td>{op.playerPhone}</td>
                <td className="num">{op.reprints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {operations.length === 0 && <p className="muted">No receipts.</p>}
    </>
  );
}

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

/**
 * Books the closed shift's cash difference as a shop loss or gain (house cash variance account),
 * the owner's default of 18 Nov; a supervisor other than the shift's cashier, once.
 */
function BookVariance({ shiftId, onDone }: { shiftId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const book = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api(`/admin/cashier/shifts/${shiftId}/variance`, { method: 'POST', body: {} });
      onDone();
    } catch (e) {
      setFailure(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <p>
      <button type="button" disabled={busy} onClick={() => void book()}>
        Book the difference
      </button>{' '}
      <span className="small muted">as a shop loss or gain in the books (once).</span>
      {failure !== null && <Notice>{failure}</Notice>}
    </p>
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
      <PageHeader title={`Shift at ${shift.shopLabel} ${shift.shopName}`}>
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
      {data.variancePosting !== null ? (
        <p className="small" data-testid="variance-booked">
          Difference booked: {formatEtb(data.variancePosting.amount)} on{' '}
          {formatDateTime(data.variancePosting.postedAt)}.
        </p>
      ) : (
        shift.status === 'closed' &&
        hasVariance(shift.variance) &&
        can('withdrawals.approve') &&
        staff?.id !== shift.staffId && <BookVariance shiftId={shift.id} onDone={reload} />
      )}
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

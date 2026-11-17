'use client';

import type { CashierShiftDetailResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, DefList, Loading, PageHeader } from '@/components/ui';
import { hasVariance, receiptPath, varianceLabel } from '@/lib/cashier';
import { formatDateTime, formatEtb } from '@/lib/format';

export default function CashShiftPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data, error, loading } = useFetch<CashierShiftDetailResponse>(
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

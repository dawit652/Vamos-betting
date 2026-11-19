import type { CashOperationView, CashierShiftView } from '@vamos/contracts';
import { hasVariance, varianceLabel } from '@/lib/cashier';
import { formatDateTime, formatEtb } from '@/lib/format';

/** The X (open) or Z (closed) report of a shift, laid out for an 80 mm roll. */
export function ShiftReport({
  shift,
  operations,
}: {
  shift: CashierShiftView;
  operations: CashOperationView[];
}) {
  const closed = shift.status === 'closed';
  const row = (label: string, value: string, bad = false) => (
    <div className="receipt-line">
      <span>{label}</span>
      <span className={bad ? 'variance-bad' : undefined}>{value}</span>
    </div>
  );
  return (
    <div className="receipt receipt-80" data-testid="shift-report">
      <strong>
        {shift.shopLabel} {shift.shopName}
      </strong>
      <div>{closed ? 'Z REPORT (shift closed)' : 'X REPORT (shift open)'}</div>
      <hr />
      {row('Cashier', shift.staffName)}
      {row('Opened', formatDateTime(shift.openedAt))}
      {closed && row('Closed', formatDateTime(shift.closedAt))}
      <hr />
      {row('Opening float', formatEtb(shift.openingFloat))}
      {row(`Deposits (${shift.deposits.count})`, formatEtb(shift.deposits.total))}
      {row(`Withdrawals (${shift.withdrawals.count})`, formatEtb(shift.withdrawals.total))}
      {row('Expected cash', formatEtb(shift.expectedCash))}
      {closed && row('Counted cash', formatEtb(shift.countedCash))}
      {closed &&
        row(
          `Variance (${varianceLabel(shift.variance)})`,
          formatEtb(shift.variance),
          hasVariance(shift.variance),
        )}
      {shift.closeNote !== null && shift.closeNote !== '' && <div>Note: {shift.closeNote}</div>}
      <hr />
      {operations.length === 0 && <div>No receipts</div>}
      {operations.map((op) => (
        <div className="receipt-line" key={op.id}>
          <span>
            {op.reference} {op.kind === 'withdrawal' ? 'W' : 'D'}
          </span>
          <span>{formatEtb(op.amount)}</span>
        </div>
      ))}
    </div>
  );
}

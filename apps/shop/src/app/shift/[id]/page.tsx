'use client';

import type { CashierShiftView, ShopDeskResponse, ShopShiftResponse } from '@vamos/contracts';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';
import { receiptClass } from '@/lib/forms';
import { TEXT } from '@/lib/text';

/**
 * The cashier's end-of-shift report (docs/plans/counter-codes-and-deposit-recovery.md, G8): what
 * came in and went out of the drawer, the expected cash, what was counted and the difference.
 * Opening the page with `?print=1` opens the print dialog. Printing it changes nothing.
 */
function ShiftReport() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const print = search.get('print') === '1';
  const [shift, setShift] = useState<CashierShiftView | null>(null);
  const [width, setWidth] = useState<58 | 80>(80);
  const [error, setError] = useState<string | null>(null);
  const printed = useRef(false);

  useEffect(() => {
    api<ShopShiftResponse>(`/shop/desk/shifts/${id}`).then(
      (res) => setShift(res.shift),
      (e: unknown) => setError(describeError(e, TEXT.deskErrors)),
    );
    // The shop's paper width (the shift report prints like its receipts).
    api<ShopDeskResponse>('/shop/desk').then(
      (res) => setWidth(res.shop.receiptWidthMm),
      () => undefined,
    );
  }, [id]);

  useEffect(() => {
    if (shift === null || !print || printed.current) return;
    printed.current = true;
    const timer = setTimeout(() => window.print(), 100);
    return () => clearTimeout(timer);
  }, [shift, print]);

  if (shift === null) {
    return (
      <div className="card">
        {error === null ? (
          <p className="muted" role="status">
            {TEXT.loading}
          </p>
        ) : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  const line = (label: string, value: string, testId?: string) => (
    <div className="ticket-line">
      <span>{label}</span>
      <span data-testid={testId}>{value}</span>
    </div>
  );
  const t = shift.tickets;
  return (
    <div data-testid="shift-report-page">
      <div className="no-print">
        <button type="button" className="primary" onClick={() => window.print()}>
          {TEXT.receiptPrint}
        </button>{' '}
        <Link href="/">{TEXT.ticketBack}</Link>
      </div>
      <div className={`${receiptClass(width)} ticket`} data-testid="shift-report">
        <div className="ticket-logo">Nahubet · ናሁቤት</div>
        <div>
          <strong>{TEXT.shiftReportTitle}</strong>
        </div>
        <div>
          {TEXT.ticketShop}: {shift.shopLabel} · {shift.shopName}
        </div>
        <div>
          {TEXT.ticketCashier}: {shift.staffName}
        </div>
        <div>
          {TEXT.shiftReportOpened}: {formatDateTime(shift.openedAt)}
        </div>
        <div>
          {TEXT.shiftReportClosed}:{' '}
          {shift.closedAt === null ? TEXT.shiftReportStillOpen : formatDateTime(shift.closedAt)}
        </div>
        <hr />
        {line(TEXT.shiftReportFloat, formatEtb(shift.openingFloat))}
        {line(
          `${TEXT.shiftReportDeposits} (${shift.deposits.count})`,
          `+ ${formatEtb(shift.deposits.total)}`,
        )}
        {line(
          `${TEXT.shiftReportWithdrawals} (${shift.withdrawals.count})`,
          `− ${formatEtb(shift.withdrawals.total)}`,
        )}
        {line(`${TEXT.shiftReportTicketsSold} (${t.soldCount})`, `+ ${formatEtb(t.sold)}`)}
        {line(
          `${TEXT.shiftReportTicketsCancelled} (${t.cancelledCount})`,
          `− ${formatEtb(t.cancelled)}`,
        )}
        {line(`${TEXT.shiftReportTicketsPaid} (${t.paidCount})`, `− ${formatEtb(t.paid)}`)}
        <hr />
        <div className="ticket-line ticket-net">
          <span>{TEXT.expectedCash}</span>
          <span data-testid="shift-report-expected">{formatEtb(shift.expectedCash)}</span>
        </div>
        {shift.countedCash === null ? null : (
          <>
            {line(TEXT.counted, formatEtb(shift.countedCash))}
            {line(TEXT.variance, formatEtb(shift.variance), 'shift-report-variance')}
          </>
        )}
        {shift.closeNote === null ? null : <div className="small">{shift.closeNote}</div>}
        <hr />
        <div className="small">{TEXT.shiftReportSign}</div>
      </div>
    </div>
  );
}

export default function ShiftReportPage() {
  return (
    <Suspense fallback={null}>
      <ShiftReport />
    </Suspense>
  );
}

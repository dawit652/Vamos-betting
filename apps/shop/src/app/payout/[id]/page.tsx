'use client';

import type { ShopTicketResponse, ShopTicketView } from '@vamos/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Barcode } from '@/components/barcode';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';
import { receiptClass } from '@/lib/forms';
import { normalizeTicketNumber } from '@/lib/payouts';
import { TEXT } from '@/lib/text';

/**
 * The payout slip of a paid ticket. The ticket is read by its number (`?number=`): the by-id
 * route answers only for the cashier who sold it, and the payout may be at another desk. With
 * `print=1` the print dialog opens once.
 */
function Slip() {
  const search = useSearchParams();
  const number = normalizeTicketNumber(search.get('number') ?? '');
  const print = search.get('print') === '1';
  const [ticket, setTicket] = useState<ShopTicketView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printed = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api<ShopTicketResponse>('/shop/desk/tickets/lookup', {
      query: { number },
      signal: controller.signal,
    }).then(
      (res) => setTicket(res.ticket),
      (e: unknown) => {
        if (!controller.signal.aborted) setError(describeError(e, TEXT.payErrors));
      },
    );
    return () => controller.abort();
  }, [number]);

  useEffect(() => {
    if (ticket === null || !print || printed.current || ticket.payState !== 'paid') return;
    printed.current = true;
    // After the paint, so the dialog shows the slip.
    const timer = setTimeout(() => window.print(), 100);
    return () => clearTimeout(timer);
  }, [ticket, print]);

  if (ticket === null) {
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

  const { shop } = ticket;
  const paid = ticket.payState === 'paid';
  return (
    <div data-testid="payout-page">
      <div className="no-print">
        {paid && (
          <>
            <button
              type="button"
              className="primary"
              data-testid="payout-print"
              onClick={() => window.print()}
            >
              {TEXT.payoutSlipPrint}
            </button>{' '}
          </>
        )}
        <Link href="/pay">{TEXT.navPay}</Link> · <Link href="/">{TEXT.ticketBack}</Link>
      </div>
      <div className={`${receiptClass(shop.receiptWidthMm)} ticket`} data-testid="payout-slip">
        <div className="ticket-logo">Nahubet · ናሁቤት</div>
        <div className="ticket-net">{TEXT.payoutSlipTitle}</div>
        <div>
          {TEXT.ticketShop}: {shop.label} · {shop.name}
        </div>
        <div>
          {TEXT.ticketCashier}: {ticket.cashierName}
        </div>
        <div>
          {TEXT.payoutSlipPaid}: {formatDateTime(ticket.paidAt)}
        </div>
        <hr />
        <div>
          {TEXT.ticketNumber}: <strong>{ticket.number}</strong>
        </div>
        <Barcode text={ticket.number} />
        <hr />
        {paid ? (
          <div className="slip-amount" data-testid="payout-amount">
            {formatEtb(ticket.payAmount)}
          </div>
        ) : (
          <div className="ticket-cancelled">{TEXT.payNothing}</div>
        )}
        <div className="small">{TEXT.payoutSlipAmount}</div>
        <div className="slip-sign">
          {TEXT.payoutSlipReceived} · {TEXT.payoutSlipReceivedAm}
        </div>
        <hr />
        <div className="small">{TEXT.payoutSlipFooter}</div>
      </div>
    </div>
  );
}

export default function PayoutPage() {
  return (
    <Suspense fallback={null}>
      <Slip />
    </Suspense>
  );
}

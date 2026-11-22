'use client';

import type { ShopTicketPrintResponse, ShopTicketResponse, ShopTicketView } from '@vamos/contracts';
import { formatBookingCode, formatPayoutCode } from '@vamos/core';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Barcode } from '@/components/barcode';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';
import { receiptClass } from '@/lib/forms';
import { TEXT } from '@/lib/text';
import { formatOddsMilli, takePayoutCode } from '@/lib/tickets';

/**
 * The printable ticket. Like the cash receipt: opening the page with `?print=1` records the
 * original print once and opens the print dialog; the Print button afterwards is a counted copy
 * that says COPY. A cancelled ticket shows CANCELLED and cannot be printed.
 */
function Ticket() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const print = search.get('print') === '1';
  const [ticket, setTicket] = useState<ShopTicketView | null>(null);
  const [isCopy, setIsCopy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The payout code of a ticket just sold (handOverPayoutCode): printed only, for this page view.
  const [payoutCode, setPayoutCode] = useState<string | null>(null);
  const started = useRef(false);
  const printed = useRef(false);

  useEffect(() => {
    // Strict mode runs effects twice; a print must be counted once.
    if (started.current) return;
    started.current = true;
    setPayoutCode(takePayoutCode(id));
    const base = `/shop/desk/tickets/${id}`;
    if (print) {
      api<ShopTicketPrintResponse>(`${base}/print`, { method: 'POST', body: {} }).then(
        (res) => {
          setIsCopy(res.copy);
          setTicket(res.ticket);
        },
        // A cancelled ticket cannot be printed: show it instead.
        () =>
          api<ShopTicketResponse>(base).then(
            (res) => setTicket(res.ticket),
            (e: unknown) => setError(describeError(e, TEXT.ticketErrors)),
          ),
      );
    } else {
      api<ShopTicketResponse>(base).then(
        (res) => {
          setIsCopy(res.ticket.originalPrintedAt !== null);
          setTicket(res.ticket);
        },
        (e: unknown) => setError(describeError(e, TEXT.ticketErrors)),
      );
    }
  }, [id, print]);

  // Once the original has been through the print dialog, anything printed again is a copy.
  useEffect(() => {
    const after = () => setIsCopy(true);
    window.addEventListener('afterprint', after);
    return () => window.removeEventListener('afterprint', after);
  }, []);

  useEffect(() => {
    if (ticket === null || !print || printed.current || ticket.status === 'cancelled') return;
    printed.current = true;
    // After the paint, so the dialog shows the ticket.
    const timer = setTimeout(() => window.print(), 100);
    return () => clearTimeout(timer);
  }, [ticket, print]);

  /** The Print button: the original if never printed, else a counted copy. */
  async function printAgain() {
    try {
      const res = await api<ShopTicketPrintResponse>(`/shop/desk/tickets/${id}/print`, {
        method: 'POST',
        body: {},
      });
      setError(null);
      setIsCopy(res.copy);
      setTicket(res.ticket);
      setTimeout(() => window.print(), 100);
    } catch (e) {
      setError(describeError(e, TEXT.ticketErrors));
    }
  }

  async function cancel() {
    const reason = window.prompt(TEXT.ticketCancelReason, '');
    if (reason === null) return;
    if (!window.confirm(TEXT.ticketCancelConfirm)) return;
    try {
      const body = reason.trim() === '' ? {} : { reason: reason.trim() };
      const res = await api<ShopTicketResponse>(`/shop/desk/tickets/${id}/cancel`, {
        method: 'POST',
        body,
      });
      setError(null);
      setTicket(res.ticket);
    } catch (e) {
      setError(describeError(e, TEXT.ticketErrors));
    }
  }

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

  const cancelled = ticket.status === 'cancelled';
  const canCancel =
    !cancelled &&
    ticket.cancellableUntil !== null &&
    new Date(ticket.cancellableUntil).getTime() > Date.now();
  const { bet, shop } = ticket;
  return (
    <div data-testid="ticket-page">
      <div className="no-print">
        {!cancelled && (
          <>
            <button
              type="button"
              className="primary"
              data-testid="ticket-print"
              onClick={() => void printAgain()}
            >
              {TEXT.ticketPrint}
            </button>{' '}
          </>
        )}
        {canCancel && (
          <>
            <button type="button" data-testid="ticket-cancel" onClick={() => void cancel()}>
              {TEXT.ticketCancel}
            </button>{' '}
          </>
        )}
        <Link href="/">{TEXT.ticketBack}</Link>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={`${receiptClass(shop.receiptWidthMm)} ticket`} data-testid="ticket">
        <div className="ticket-logo">Nahubet · ናሁቤት</div>
        <div>
          {TEXT.ticketAgent}: {shop.agentNumber} · {shop.agentName}
        </div>
        <div>
          {TEXT.ticketShop}: {shop.label} · {shop.name}
        </div>
        <div>
          {TEXT.ticketCashier}: {ticket.cashierName}
        </div>
        <div>
          {TEXT.ticketSold}: {formatDateTime(ticket.soldAt)}
        </div>
        {isCopy && !cancelled && (
          <div className="receipt-copy" data-testid="ticket-copy-badge">
            {TEXT.ticketCopy}
          </div>
        )}
        {cancelled && (
          <div className="ticket-cancelled" data-testid="ticket-cancelled">
            {TEXT.ticketCancelled}
            <div className="small">{TEXT.ticketCancelNote}</div>
          </div>
        )}
        <hr />
        <div>
          {TEXT.ticketNumber}: <strong data-testid="ticket-number">{ticket.number}</strong>
        </div>
        <hr />
        {bet.legs.map((leg) => (
          <div key={leg.selectionId} className="ticket-leg">
            <div>
              {TEXT.ticketGame} {leg.gameId}
            </div>
            <div>
              <strong>
                {leg.homeTeam.en} - {leg.awayTeam.en}
              </strong>
            </div>
            <div>
              {leg.marketName.en}: <strong>{leg.selectionName.en}</strong> @{' '}
              {formatOddsMilli(leg.oddsMilli)}
            </div>
            <div className="small">
              {TEXT.ticketKickoff}: {formatDateTime(leg.startTime)}
            </div>
          </div>
        ))}
        <hr />
        <div className="ticket-line">
          <span>{TEXT.ticketTotalOdds}</span>
          <span>{formatOddsMilli(bet.totalOddsMilli)}</span>
        </div>
        <div className="ticket-line">
          <span>{TEXT.ticketStake}</span>
          <span>{formatEtb(bet.stake)}</span>
        </div>
        <div className="ticket-line">
          <span>{TEXT.ticketPossibleWin}</span>
          <span>{formatEtb(bet.potentialGross)}</span>
        </div>
        <div className="ticket-line">
          <span>{TEXT.ticketTax}</span>
          <span>{formatEtb(bet.potentialTax)}</span>
        </div>
        <div className="ticket-line ticket-net">
          <span>{TEXT.ticketNetPay}</span>
          <span>{formatEtb(bet.potentialNet)}</span>
        </div>
        <hr />
        <Barcode text={ticket.number} />
        {payoutCode !== null && ticket.status !== 'cancelled' && (
          // On paper only: the screen never shows it (print-only).
          <div className="print-only ticket-payout-code" data-testid="ticket-payout-code">
            <div>
              {TEXT.ticketPayoutCode} <strong>{formatPayoutCode(payoutCode)}</strong>
            </div>
            <div className="small">{TEXT.ticketPayoutCodeNote}</div>
          </div>
        )}
        {ticket.bookingCode !== null && (
          <div className="small" data-testid="ticket-booking-code">
            {TEXT.ticketBookingCode} {formatBookingCode(ticket.bookingCode)}
          </div>
        )}
        <hr />
        <div className="small">{TEXT.ticketFooter}</div>
        <div className="small" lang="am">
          {TEXT.ticketFooterAm}
        </div>
      </div>
    </div>
  );
}

export default function TicketPage() {
  return (
    <Suspense fallback={null}>
      <Ticket />
    </Suspense>
  );
}

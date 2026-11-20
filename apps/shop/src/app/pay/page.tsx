'use client';

import type {
  ShopDeskResponse,
  ShopPayTicketRequest,
  ShopPayTicketResponse,
  ShopTicketResponse,
  ShopTicketView,
} from '@vamos/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { api } from '@/lib/api';
import { ApiClientError, describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';
import {
  newPayoutKey,
  normalizeTicketNumber,
  notPayableText,
  payoutSlipPath,
  payStateLabel,
  payStateTone,
} from '@/lib/payouts';
import { TEXT } from '@/lib/text';
import { formatOddsMilli } from '@/lib/tickets';

/** The words for a failed lookup or payout: the page's codes, the not-payable state, the rest. */
function payError(e: unknown): string {
  if (e instanceof ApiClientError && e.code === 'ticket_not_payable') {
    const state = (e.details as { state?: unknown } | null | undefined)?.state;
    return notPayableText(state);
  }
  if (e instanceof ApiClientError && e.status === 404) return TEXT.payErrors.ticket_not_found!;
  return describeError(e, TEXT.payErrors);
}

function Payer({ shiftId }: { shiftId: string }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [ticket, setTicket] = useState<ShopTicketView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per ticket, kept until the payout succeeded (a retry after a network error is safe).
  const key = useRef<{ number: string; key: string } | null>(null);

  async function find(event?: FormEvent) {
    event?.preventDefault();
    const number = normalizeTicketNumber(text);
    setMessage(null);
    if (number === '') {
      setError(TEXT.payNumberShort);
      return;
    }
    setBusy(true);
    try {
      const res = await api<ShopTicketResponse>('/shop/desk/tickets/lookup', {
        query: { number },
      });
      setError(null);
      setTicket(res.ticket);
    } catch (e) {
      setTicket(null);
      setError(payError(e));
    } finally {
      setBusy(false);
    }
  }

  async function pay(t: ShopTicketView) {
    if (t.payAmount === null || !window.confirm(TEXT.payConfirm(formatEtb(t.payAmount)))) return;
    if (key.current === null || key.current.number !== t.number) {
      key.current = { number: t.number, key: newPayoutKey() };
    }
    const body: ShopPayTicketRequest = {
      shiftId,
      number: t.number,
      idempotencyKey: key.current.key,
    };
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<ShopPayTicketResponse>('/shop/desk/tickets/payouts', {
        method: 'POST',
        body,
      });
      key.current = null;
      setError(null);
      setTicket(res.ticket);
      if (res.outcome === 'paid') {
        setMessage(TEXT.payDone(formatEtb(res.amount)));
        router.push(payoutSlipPath(res.ticket.id, res.ticket.number, true));
      } else {
        setMessage(TEXT.payNeedsApproval);
      }
    } catch (e) {
      setError(payError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="pay-page">
      <h1>{TEXT.payTitle}</h1>
      <form className="card" onSubmit={(e) => void find(e)}>
        <label>
          {TEXT.payNumber}
          <input
            autoFocus
            autoComplete="off"
            data-testid="pay-number"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>{' '}
        <button type="submit" className="primary" data-testid="pay-find" disabled={busy}>
          {busy ? TEXT.payFinding : TEXT.payFind}
        </button>
      </form>
      {error !== null && (
        <p className="error" role="alert" data-testid="pay-error">
          {error}
        </p>
      )}
      {message !== null && (
        <p className="notice" role="status" data-testid="pay-message">
          {message}
        </p>
      )}
      {ticket !== null && <TicketCard ticket={ticket} busy={busy} onPay={() => void pay(ticket)} />}
    </div>
  );
}

function TicketCard({
  ticket,
  busy,
  onPay,
}: {
  ticket: ShopTicketView;
  busy: boolean;
  onPay: () => void;
}) {
  const { bet, shop, payState } = ticket;
  return (
    <div className="card" data-testid="pay-ticket">
      <div>
        <strong data-testid="pay-ticket-number">{ticket.number}</strong>
      </div>
      <div className="muted small">
        {TEXT.paySold}: {shop.label} · {shop.name} · {formatDateTime(ticket.soldAt)}
      </div>
      <div data-testid="pay-state" className={`pay-banner pay-${payStateTone(payState)}`}>
        {payStateLabel(payState)}
        {(payState === 'payable' || payState === 'awaiting_approval' || payState === 'paid') &&
          ticket.payAmount !== null && (
            <div className="pay-amount" data-testid="pay-amount">
              {formatEtb(ticket.payAmount)}
            </div>
          )}
        {payState === 'paid' && ticket.paidAt !== null && (
          <div className="small">{formatDateTime(ticket.paidAt)}</div>
        )}
      </div>
      {payState === 'payable' && (
        <p>
          <button
            type="button"
            className="primary"
            data-testid="pay-submit"
            disabled={busy}
            onClick={onPay}
          >
            {TEXT.paySubmit} {formatEtb(ticket.payAmount)}
          </button>
        </p>
      )}
      {bet.legs.map((leg) => (
        <div key={leg.selectionId} className="ticket-leg">
          <strong>
            {leg.homeTeam.en} - {leg.awayTeam.en}
          </strong>
          <div>
            {leg.marketName.en}: <strong>{leg.selectionName.en}</strong> @{' '}
            {formatOddsMilli(leg.oddsMilli)} · {leg.state}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PayPage() {
  const desk = useFetch<ShopDeskResponse>('/shop/desk');
  if (desk.data === null) {
    return (
      <div className="card">
        {desk.error === null ? (
          <p className="muted" role="status">
            {TEXT.loading}
          </p>
        ) : (
          <p className="error" role="alert">
            {desk.error}
          </p>
        )}
      </div>
    );
  }
  const shift = desk.data.shift;
  if (shift === null) {
    return (
      <div data-testid="pay-page">
        <h1>{TEXT.payTitle}</h1>
        <p className="card">
          {TEXT.payNeedShift}. <Link href="/">{TEXT.payNeedShiftLink}</Link>
        </p>
      </div>
    );
  }
  return <Payer shiftId={shift.id} />;
}

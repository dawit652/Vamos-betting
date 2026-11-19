'use client';

import type {
  CashierShiftView,
  ShopDeskResponse,
  ShopOpenShiftRequest,
  ShopShiftResponse,
} from '@vamos/contracts';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { cashToSantim } from '@/lib/forms';
import { formatDateTime, formatEtb } from '@/lib/format';
import { TEXT } from '@/lib/text';

export default function DeskPage() {
  const desk = useFetch<ShopDeskResponse>('/shop/desk');
  const [closed, setClosed] = useState<CashierShiftView | null>(null);

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
  const { shift, operations } = desk.data;
  return (
    <>
      <h1 className="no-print">{TEXT.deskTitle}</h1>
      {shift === null ? (
        <>
          {closed === null ? null : <ClosedSummary shift={closed} />}
          <OpenShiftForm
            onOpened={() => {
              setClosed(null);
              desk.reload();
            }}
          />
        </>
      ) : (
        <>
          <ShiftSummary shift={shift} />
          <CloseShiftForm
            shift={shift}
            onClosed={(result) => {
              setClosed(result);
              desk.reload();
            }}
          />
          <Receipts operations={operations} />
        </>
      )}
      <p className="muted">{TEXT.sellingSoon}</p>
    </>
  );
}

function OpenShiftForm({ onOpened }: { onOpened: () => void }) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const openingFloat = cashToSantim(amount);
    if (openingFloat === null) {
      setError(TEXT.floatInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const body: ShopOpenShiftRequest = { openingFloat };
    try {
      await api<ShopShiftResponse>('/shop/desk/shifts', { method: 'POST', body });
      onOpened();
    } catch (e) {
      setError(describeError(e, TEXT.deskErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="open-shift">
      <h2 id="open-shift">{TEXT.openShiftTitle}</h2>
      <p className="muted">{TEXT.noShift}</p>
      <form onSubmit={(e) => void submit(e)} aria-label="Open shift">
        <label htmlFor="opening-float">
          {TEXT.openingFloat}
          <input
            id="opening-float"
            inputMode="decimal"
            autoComplete="off"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? TEXT.openShiftBusy : TEXT.openShiftButton}
        </button>
      </form>
    </section>
  );
}

function ShiftSummary({ shift }: { shift: CashierShiftView }) {
  return (
    <section className="card" aria-labelledby="shift-title">
      <h2 id="shift-title">{TEXT.shiftTitle}</h2>
      <dl className="summary" data-testid="shift-summary">
        <div>
          <dt>{TEXT.openedAt}</dt>
          <dd>{formatDateTime(shift.openedAt)}</dd>
        </div>
        <div>
          <dt>{TEXT.float}</dt>
          <dd>{formatEtb(shift.openingFloat)}</dd>
        </div>
        <div>
          <dt>
            {TEXT.deposits} ({shift.deposits.count})
          </dt>
          <dd>{formatEtb(shift.deposits.total)}</dd>
        </div>
        <div>
          <dt>
            {TEXT.withdrawals} ({shift.withdrawals.count})
          </dt>
          <dd>{formatEtb(shift.withdrawals.total)}</dd>
        </div>
        <div>
          <dt>{TEXT.expectedCash}</dt>
          <dd>{formatEtb(shift.expectedCash)}</dd>
        </div>
      </dl>
    </section>
  );
}

function CloseShiftForm({
  shift,
  onClosed,
}: {
  shift: CashierShiftView;
  onClosed: (shift: CashierShiftView) => void;
}) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const countedCash = cashToSantim(amount);
    if (countedCash === null) {
      setError(TEXT.countInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const trimmed = note.trim();
    const body = trimmed === '' ? { countedCash } : { countedCash, note: trimmed };
    try {
      const result = await api<ShopShiftResponse>(`/shop/desk/shifts/${shift.id}/close`, {
        method: 'POST',
        body,
      });
      onClosed(result.shift);
    } catch (e) {
      setError(describeError(e, TEXT.deskErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="close-shift">
      <h2 id="close-shift">{TEXT.closeShiftTitle}</h2>
      <form onSubmit={(e) => void submit(e)} aria-label="Close shift">
        <label htmlFor="counted-cash">
          {TEXT.countedCash}
          <input
            id="counted-cash"
            inputMode="decimal"
            autoComplete="off"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label htmlFor="close-note">
          {TEXT.closeNote}
          <textarea
            id="close-note"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? TEXT.closeShiftBusy : TEXT.closeShiftButton}
        </button>
      </form>
    </section>
  );
}

function ClosedSummary({ shift }: { shift: CashierShiftView }) {
  const bad = shift.variance !== null && !/^-?0+$/.test(shift.variance);
  return (
    <section className="card notice" role="status" data-testid="closed-shift">
      <h2>{TEXT.closedSummary}</h2>
      <p>
        {TEXT.expectedCash}: {formatEtb(shift.expectedCash)} · {TEXT.counted}:{' '}
        {formatEtb(shift.countedCash)} ·{' '}
        <span className={bad ? 'variance-bad' : undefined}>
          {TEXT.variance}: {formatEtb(shift.variance)}
        </span>
      </p>
    </section>
  );
}

function Receipts({ operations }: { operations: ShopDeskResponse['operations'] }) {
  return (
    <section className="card" aria-labelledby="receipts">
      <h2 id="receipts">{TEXT.receiptsTitle}</h2>
      {operations.length === 0 ? (
        <p className="muted">{TEXT.noReceipts}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{TEXT.colTime}</th>
                <th>{TEXT.colReceipt}</th>
                <th>{TEXT.colKind}</th>
                <th className="num">{TEXT.colAmount}</th>
                <th>{TEXT.colPlayer}</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((op) => (
                <tr key={op.id}>
                  <td>{formatDateTime(op.createdAt)}</td>
                  <td>{op.reference}</td>
                  <td>{TEXT.kind[op.kind] ?? op.kind}</td>
                  <td className="num">{formatEtb(op.amount)}</td>
                  <td>{op.playerPhone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

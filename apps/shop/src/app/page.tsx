'use client';

import type {
  CashDepositRequest,
  CashDepositResponse,
  CashierPlayerResponse,
  CashierPlayerView,
  CashierShiftView,
  CashWithdrawalRequest,
  CashWithdrawalResponse,
  ShopDeskResponse,
  ShopOpenShiftRequest,
  ShopShiftResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { api } from '@/lib/api';
import { ApiClientError, describeError } from '@/lib/errors';
import {
  cashToSantim,
  playerServable,
  positiveCashToSantim,
  receiptPath,
  reviewReasonLabel,
} from '@/lib/forms';
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
  const { shift, operations, playerCash, agentBalance } = desk.data;
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
          <PlayerDesk
            shift={shift}
            playerCash={playerCash}
            agentBalance={agentBalance}
            onChanged={desk.reload}
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
                <th className="num">{TEXT.colCopies}</th>
                <th />
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
                  <td className="num">{op.reprints}</td>
                  <td>
                    <Link href={receiptPath(op.id)}>{TEXT.receiptLink}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Players' cash at the counter: find the player by phone, take a deposit, pay a withdrawal. Each
 * form keeps its idempotency key until the request finished (paid or sent to review), so a retry
 * after an error or a double click reuses it and can never record the cash twice.
 */
function PlayerDesk({
  shift,
  playerCash,
  agentBalance,
  onChanged,
}: {
  shift: CashierShiftView;
  playerCash: boolean;
  agentBalance: string | null;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [player, setPlayer] = useState<CashierPlayerView | null>(null);
  const [amount, setAmount] = useState('');
  const [depositKey, setDepositKey] = useState(() => `desk-${crypto.randomUUID()}`);
  const [wAmount, setWAmount] = useState('');
  const [wCode, setWCode] = useState('');
  const [withdrawKey, setWithdrawKey] = useState(() => `desk-${crypto.randomUUID()}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(null);

  async function lookup(query: string): Promise<CashierPlayerView> {
    const res = await api<CashierPlayerResponse>('/shop/desk/players', {
      query: { phone: query },
    });
    return res.player;
  }

  async function find(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setReview(null);
    try {
      setPlayer(await lookup(phone.trim()));
      setAmount('');
      setDepositKey(`desk-${crypto.randomUUID()}`);
      setWAmount('');
      setWCode('');
      setWithdrawKey(`desk-${crypto.randomUUID()}`);
    } catch (e) {
      setPlayer(null);
      setError(
        e instanceof ApiClientError && e.status === 404
          ? TEXT.playerNotFound
          : describeError(e, TEXT.deskErrors),
      );
    } finally {
      setBusy(false);
    }
  }

  async function deposit(event: FormEvent) {
    event.preventDefault();
    if (player === null || busy) return;
    const santim = positiveCashToSantim(amount);
    if (santim === null) {
      setError(TEXT.amountInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    setReview(null);
    const body: CashDepositRequest = {
      shiftId: shift.id,
      userId: player.id,
      amount: santim,
      idempotencyKey: depositKey,
    };
    try {
      const res = await api<CashDepositResponse>('/shop/desk/deposits', {
        method: 'POST',
        body,
      });
      // Only a finished deposit retires the key: a retry after an error reuses it.
      setDepositKey(`desk-${crypto.randomUUID()}`);
      onChanged();
      router.push(receiptPath(res.receipt.operation.id, 'print'));
    } catch (e) {
      setError(describeError(e, TEXT.deskErrors));
      setBusy(false);
    }
  }

  async function withdraw(event: FormEvent) {
    event.preventDefault();
    if (player === null || busy) return;
    const santim = positiveCashToSantim(wAmount);
    if (santim === null) {
      setError(TEXT.amountInvalid);
      return;
    }
    if (!/^\d{6}$/.test(wCode)) {
      setError(TEXT.codeInvalidShop);
      return;
    }
    setBusy(true);
    setError(null);
    setReview(null);
    const body: CashWithdrawalRequest = {
      shiftId: shift.id,
      userId: player.id,
      amount: santim,
      code: wCode,
      idempotencyKey: withdrawKey,
    };
    try {
      const res = await api<CashWithdrawalResponse>('/shop/desk/withdrawals', {
        method: 'POST',
        body,
      });
      // Paid or sent to review both finish the request, so the key is renewed (an error keeps it).
      setWithdrawKey(`desk-${crypto.randomUUID()}`);
      setWCode('');
      setWAmount('');
      onChanged();
      if (res.outcome === 'paid') {
        router.push(receiptPath(res.receipt.operation.id, 'print'));
        return;
      }
      setReview(
        `${TEXT.withdrawReviewPrefix} ${formatEtb(res.amount)} (${reviewReasonLabel(
          res.reviewReason,
        )}) ${TEXT.withdrawReviewSuffix}`,
      );
      setPlayer(await lookup(phone.trim()));
    } catch (e) {
      setError(describeError(e, TEXT.deskErrors));
    } finally {
      setBusy(false);
    }
  }

  if (!playerCash) {
    return (
      <section className="card" aria-labelledby="players" data-testid="desk-players">
        <h2 id="players">{TEXT.playersTitle}</h2>
        <p className="notice" role="status" data-testid="player-cash-off">
          {TEXT.playerCashOff}
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="players" data-testid="desk-players">
      <h2 id="players">{TEXT.playersTitle}</h2>
      {agentBalance === null ? null : (
        <p data-testid="desk-agent-balance">
          <strong>
            {TEXT.agentBalance}: {formatEtb(agentBalance)}
          </strong>{' '}
          <span className="muted small">{TEXT.agentBalanceNote}</span>
        </p>
      )}
      <form onSubmit={(e) => void find(e)} aria-label="Find player">
        <label htmlFor="player-phone">
          {TEXT.playerPhone}
          <input
            id="player-phone"
            data-testid="player-phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder={TEXT.playerPhonePlaceholder}
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <button type="submit" data-testid="player-lookup" disabled={busy || phone.trim() === ''}>
          {busy ? TEXT.playerLooking : TEXT.playerLookup}
        </button>
      </form>
      {error === null ? null : (
        <p className="error" role="alert" data-testid="desk-error">
          {error}
        </p>
      )}
      {review === null ? null : (
        <p className="notice" role="status" data-testid="withdraw-review">
          {review}
        </p>
      )}
      {player === null ? null : (
        <div data-testid="player-card">
          <dl className="summary">
            <div>
              <dt>{TEXT.colPlayer}</dt>
              <dd>
                {player.name ?? TEXT.playerNoName} · {player.phone}
              </dd>
            </div>
            <div>
              <dt>{TEXT.playerStatus}</dt>
              <dd>{player.status}</dd>
            </div>
            <div>
              <dt>{TEXT.playerKyc}</dt>
              <dd>{player.kycStatus}</dd>
            </div>
            <div>
              <dt>{TEXT.playerCash}</dt>
              <dd>{formatEtb(player.cash)}</dd>
            </div>
            <div>
              <dt>{TEXT.playerBonus}</dt>
              <dd>{formatEtb(player.bonus)}</dd>
            </div>
          </dl>
          <p className="muted small">
            {player.exclusion === null
              ? TEXT.playerNoExclusion
              : `${TEXT.playerExcluded} (${player.exclusion.kind})${
                  player.exclusion.endsAt === null
                    ? ''
                    : ` ${TEXT.playerUntil} ${formatDateTime(player.exclusion.endsAt)}`
                }.`}
          </p>
          {!playerServable(player) ? (
            <p className="error" role="alert">
              {TEXT.playerBlocked}
            </p>
          ) : (
            <>
              <form onSubmit={(e) => void deposit(e)} aria-label="Cash deposit">
                <h3>{TEXT.depositTitle}</h3>
                <label htmlFor="deposit-amount">
                  {TEXT.depositAmount}
                  <input
                    id="deposit-amount"
                    data-testid="deposit-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="primary"
                  data-testid="deposit-submit"
                  disabled={busy || amount.trim() === ''}
                >
                  {busy ? TEXT.depositBusy : TEXT.depositButton}
                </button>
              </form>
              <form onSubmit={(e) => void withdraw(e)} aria-label="Cash withdrawal">
                <h3>{TEXT.withdrawTitle}</h3>
                <label htmlFor="withdraw-amount">
                  {TEXT.withdrawAmount}
                  <input
                    id="withdraw-amount"
                    data-testid="withdraw-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={wAmount}
                    onChange={(e) => setWAmount(e.target.value)}
                  />
                </label>
                <label htmlFor="withdraw-code">
                  {TEXT.withdrawCode}
                  <input
                    id="withdraw-code"
                    data-testid="withdraw-code"
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="off"
                    value={wCode}
                    onChange={(e) => setWCode(e.target.value.replace(/\D/g, ''))}
                  />
                </label>
                {player.name === null ? null : (
                  <p className="muted small">
                    {TEXT.withdrawNameCheck} {player.name}
                  </p>
                )}
                {player.kycStatus === 'verified' ? null : (
                  <p className="error" role="alert">
                    {TEXT.withdrawKycNeeded}
                  </p>
                )}
                <button
                  type="submit"
                  className="primary"
                  data-testid="withdraw-submit"
                  disabled={busy || wAmount.trim() === '' || wCode.length !== 6}
                >
                  {busy ? TEXT.depositBusy : TEXT.withdrawButton}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </section>
  );
}

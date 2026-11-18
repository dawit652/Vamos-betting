'use client';

import type {
  CashDepositResponse,
  CashOperationView,
  CashWithdrawalResponse,
  CashierDeskResponse,
  CashierPlayerResponse,
  CashierPlayerView,
  CashierShiftResponse,
  CashierShiftView,
  SetPlayerStatusResponse,
  CashierDepositsResponse,
  CashierDepositView,
  DeskPinResetCodeResponse,
  DeskPinResetResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { ShiftReport } from '@/components/shift-report';
import { Badge, Loading, Notice, PageHeader, ReasonAction } from '@/components/ui';
import { api } from '@/lib/api';
import { hasVariance, receiptPath, reviewReasonLabel } from '@/lib/cashier';
import { ApiClientError, describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, parseEtbToSantim } from '@/lib/format';

function OpenShiftForm({ desk, onDone }: { desk: CashierDeskResponse; onDone: () => void }) {
  const [shopId, setShopId] = useState(desk.shops[0]?.id ?? '');
  const [float, setFloat] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const openingFloat = parseEtbToSantim(float);
    if (openingFloat === null) return setError('Enter the opening float in ETB, for example 500.');
    setBusy(true);
    setError(null);
    try {
      await api('/admin/cashier/shifts', { method: 'POST', body: { shopId, openingFloat } });
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <select aria-label="Shop" value={shopId} onChange={(e) => setShopId(e.target.value)}>
        {desk.shops.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Opening float (ETB)"
        placeholder="Opening float (ETB)"
        inputMode="decimal"
        value={float}
        onChange={(e) => setFloat(e.target.value)}
      />
      <button type="submit" className="primary" disabled={busy || shopId === ''}>
        Open shift
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

function CloseShiftForm({
  shift,
  onClosed,
}: {
  shift: CashierShiftView;
  onClosed: (shift: CashierShiftView) => void;
}) {
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const countedCash = parseEtbToSantim(counted);
    if (countedCash === null) return setError('Enter the counted cash in ETB.');
    setBusy(true);
    setError(null);
    try {
      const body = note.trim() === '' ? { countedCash } : { countedCash, note: note.trim() };
      const res = await api<CashierShiftResponse>(`/admin/cashier/shifts/${shift.id}/close`, {
        method: 'POST',
        body,
      });
      onClosed(res.shift);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <input
        aria-label="Counted cash (ETB)"
        placeholder="Counted cash (ETB)"
        inputMode="decimal"
        value={counted}
        onChange={(e) => setCounted(e.target.value)}
      />
      <input
        aria-label="Note"
        placeholder="Note (optional)"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button type="submit" disabled={busy || counted.trim() === ''}>
        Close shift
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

function PlayerDesk({
  desk,
  shift,
  onDeposit,
}: {
  desk: CashierDeskResponse;
  shift: CashierShiftView;
  onDeposit: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [player, setPlayer] = useState<CashierPlayerView | null>(null);
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [wAmount, setWAmount] = useState('');
  const [wCode, setWCode] = useState('');
  const [wKey, setWKey] = useState(() => crypto.randomUUID());
  const [review, setReview] = useState<string | null>(null);
  const shop = desk.shops.find((s) => s.id === shift.shopId);

  const find = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    setReview(null);
    try {
      const res = await api<CashierPlayerResponse>('/admin/cashier/players', {
        query: { phone: phone.trim() },
      });
      setPlayer(res.player);
      setAmount('');
      setKey(crypto.randomUUID());
      setWAmount('');
      setWCode('');
      setWKey(crypto.randomUUID());
    } catch (e) {
      setPlayer(null);
      setError(
        e instanceof ApiClientError && e.status === 404
          ? 'No player with that phone number.'
          : describeError(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const deposit = async (event: FormEvent) => {
    event.preventDefault();
    if (player === null || busy) return;
    const santim = parseEtbToSantim(amount);
    if (santim === null || santim === '0') return setError('Enter the amount in ETB.');
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await api<CashDepositResponse>('/admin/cashier/deposits', {
        method: 'POST',
        body: { shiftId: shift.id, userId: player.id, amount: santim, idempotencyKey: key },
      });
      const { operation } = res.receipt;
      setDone(
        `Receipt ${operation.reference} — ${formatEtb(operation.amount)} credited${
          res.replayed ? ' (already recorded)' : ''
        }`,
      );
      // Only a finished deposit retires the key: a retry after an error reuses it.
      setKey(crypto.randomUUID());
      setAmount('');
      window.open(receiptPath(operation.id, 'print'), '_blank');
      onDeposit();
      const fresh = await api<CashierPlayerResponse>('/admin/cashier/players', {
        query: { phone: phone.trim() },
      });
      setPlayer(fresh.player);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (event: FormEvent) => {
    event.preventDefault();
    if (player === null || busy) return;
    const santim = parseEtbToSantim(wAmount);
    if (santim === null || santim === '0') return setError('Enter the amount in ETB.');
    if (!/^\d{6}$/.test(wCode)) return setError("Enter the player's 6-digit shop code.");
    setBusy(true);
    setError(null);
    setDone(null);
    setReview(null);
    try {
      const res = await api<CashWithdrawalResponse>('/admin/cashier/withdrawals', {
        method: 'POST',
        body: {
          shiftId: shift.id,
          userId: player.id,
          amount: santim,
          code: wCode,
          idempotencyKey: wKey,
        },
      });
      // Paid or sent to review: both finish the request, so the key is renewed (an error keeps it).
      setWKey(crypto.randomUUID());
      setWCode('');
      if (res.outcome === 'paid') {
        const { operation } = res.receipt;
        setDone(
          `Pay ${formatEtb(operation.amount)} to the player. Receipt ${operation.reference}${
            res.replayed ? ' (already recorded)' : ''
          }`,
        );
        setWAmount('');
        window.open(receiptPath(operation.id, 'print'), '_blank');
        onDeposit();
        const fresh = await api<CashierPlayerResponse>('/admin/cashier/players', {
          query: { phone: phone.trim() },
        });
        setPlayer(fresh.player);
      } else {
        setReview(
          `Not paid: this withdrawal of ${formatEtb(res.amount)} needs approval by the back office (${reviewReasonLabel(
            res.reviewReason,
          )}). The money is on hold. The player comes back with a new code once it is approved.`,
        );
        setWAmount('');
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const blockPlayer = async (reason: string) => {
    if (player === null) return;
    await api<SetPlayerStatusResponse>(`/admin/cashier/players/${player.id}/block`, {
      method: 'POST',
      body: { reason },
    });
    const fresh = await api<CashierPlayerResponse>('/admin/cashier/players', {
      query: { phone: phone.trim() },
    });
    setPlayer(fresh.player);
  };

  const blocked = player !== null && (player.status !== 'active' || player.exclusion !== null);
  return (
    <section>
      <h2>Player</h2>
      <form className="inline-form" onSubmit={(e) => void find(e)}>
        <input
          aria-label="Player phone"
          placeholder="Phone: 09…, 9… or +2519…"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <button type="submit" disabled={busy || phone.trim().length < 9}>
          Find
        </button>
      </form>
      {player !== null && (
        <div data-testid="cashier-player">
          <p>
            <strong>{player.name ?? 'No name on file'}</strong> · {player.phone}
          </p>
          <p>
            Status <Badge value={player.status} /> · KYC <Badge value={player.kycStatus} />
          </p>
          <p>
            Cash {formatEtb(player.cash)} · Bonus {formatEtb(player.bonus)}
          </p>
          <p className="muted small">
            {player.exclusion === null
              ? 'No self-exclusion.'
              : `Self-excluded (${player.exclusion.kind})${
                  player.exclusion.endsAt === null
                    ? ''
                    : ` until ${formatDateTime(player.exclusion.endsAt)}`
                }.`}
          </p>
          <RecentDeposits playerId={player.id} supervisor={desk.supervisor} />
          {desk.pinResetEnabled &&
            player.kycStatus === 'verified' &&
            player.status === 'active' && <DeskPinReset playerId={player.id} />}
          {blocked ? (
            <Notice>This player cannot be served.</Notice>
          ) : (
            <form className="inline-form" onSubmit={(e) => void deposit(e)}>
              <input
                aria-label="Deposit amount (ETB)"
                placeholder="Amount (ETB)"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button type="submit" className="primary" disabled={busy || amount.trim() === ''}>
                Take cash deposit
              </button>
              {!desk.supervisor && shop !== undefined && (
                <span className="muted small">
                  Above {formatEtb(shop.approvalThreshold)} a supervisor takes the deposit.
                </span>
              )}
            </form>
          )}
          {!blocked && (
            <form className="inline-form" onSubmit={(e) => void withdraw(e)}>
              <input
                aria-label="Withdrawal amount (ETB)"
                placeholder="Withdrawal (ETB)"
                inputMode="decimal"
                value={wAmount}
                onChange={(e) => setWAmount(e.target.value)}
              />
              <input
                aria-label="Player's shop code"
                placeholder="Player's shop code"
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                value={wCode}
                onChange={(e) => setWCode(e.target.value.replace(/\D/g, ''))}
              />
              <button
                type="submit"
                className="primary"
                disabled={busy || wAmount.trim() === '' || wCode.length !== 6}
              >
                Pay cash withdrawal
              </button>
              <span className="muted small">
                KYC <Badge value={player.kycStatus} />
                {player.name !== null &&
                  ` · Check the player's ID: the name must match ${player.name}`}
              </span>
              {player.kycStatus !== 'verified' && (
                <Notice>The player must verify their identity before withdrawing.</Notice>
              )}
            </form>
          )}
          {player.status === 'active' && (
            <div className="actions">
              <ReasonAction
                label="Block player"
                submitLabel="Confirm block"
                prompt="Reason (phone reported stolen, suspected fraud, the player asked)"
                danger
                onSubmit={blockPlayer}
              />
            </div>
          )}
        </div>
      )}
      {review !== null && <Notice kind="info">{review}</Notice>}
      {done !== null && <Notice kind="ok">{done}</Notice>}
      {error !== null && <Notice>{error}</Notice>}
    </section>
  );
}

function Operations({ desk }: { desk: CashierDeskResponse }) {
  return (
    <>
      <h2>This shift&apos;s receipts</h2>
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
              <th />
            </tr>
          </thead>
          <tbody>
            {desk.operations.map((op) => (
              <tr key={op.id}>
                <td>{formatDateTime(op.createdAt)}</td>
                <td>{op.reference}</td>
                <td>{op.kind}</td>
                <td className="num">{formatEtb(op.amount)}</td>
                <td>{op.playerPhone}</td>
                <td className="num">{op.reprints}</td>
                <td>
                  <a href={receiptPath(op.id, 'copy')} target="_blank" rel="noreferrer">
                    Print copy
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {desk.operations.length === 0 && <p className="muted">No receipts yet.</p>}
    </>
  );
}

/** The cashier desk: open a shift, serve players with cash deposits and receipts, close with a count. */
/**
 * PIN reset at the desk (for a player without SMS or Telegram): the cashier types the ID number from
 * the player's card (checked against the verified ID), a supervisor approves, then the desk shows the
 * one-time code to give the player, who sets a new PIN on "Forgot PIN". The desk never sees the PIN.
 */
function DeskPinReset({ playerId }: { playerId: string }) {
  const { data, reload } = useFetch<DeskPinResetResponse>(
    `/admin/cashier/players/${playerId}/pin-reset`,
  );
  const [idNumber, setIdNumber] = useState('');
  const [code, setCode] = useState<DeskPinResetCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await work();
    } catch (e) {
      setFailure(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const ask = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await api(`/admin/cashier/players/${playerId}/pin-reset`, {
        method: 'POST',
        body: { idNumber },
      });
      setIdNumber('');
      reload();
    });
  };
  const issue = (resetId: string) =>
    void run(async () => {
      setCode(
        await api<DeskPinResetCodeResponse>(`/admin/cashier/pin-resets/${resetId}/issue`, {
          method: 'POST',
          body: {},
        }),
      );
      reload();
    });
  const reset = data?.reset ?? null;
  return (
    <section data-testid="cashier-pin-reset">
      <h3>PIN reset (ID check)</h3>
      {code !== null ? (
        <div>
          <p>
            Give the player this code: <strong className="receipt-code">{code.code}</strong>
          </p>
          <p className="small">
            On Nahubet, Forgot PIN: the phone number, this code and a new PIN, before{' '}
            {formatDateTime(code.expiresAt)}. The code works once.
          </p>
        </div>
      ) : reset === null ? (
        <form className="inline-form" onSubmit={ask}>
          <input
            aria-label="ID number on the card"
            placeholder="ID number (FIN or FAN)"
            inputMode="numeric"
            value={idNumber}
            onChange={(e) => setIdNumber(e.target.value)}
          />
          <button type="submit" disabled={busy || idNumber.trim() === ''}>
            Ask a PIN reset
          </button>
        </form>
      ) : reset.status === 'requested' ? (
        <p className="small">
          Waiting for a supervisor to approve.{' '}
          <button type="button" onClick={reload} disabled={busy}>
            Check again
          </button>
        </p>
      ) : (
        <p>
          <button type="button" className="primary" onClick={() => issue(reset.id)} disabled={busy}>
            Show the code for the player
          </button>
        </p>
      )}
      {failure !== null && <Notice>{failure}</Notice>}
    </section>
  );
}

/** What a deposit's state means to the player at the desk. */
function depositState(d: CashierDepositView): string {
  if (d.flagged) return 'Under review by staff';
  switch (d.status) {
    case 'succeeded':
      return 'Credited';
    case 'created':
    case 'pending':
      return 'Waiting for the payment';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired (not paid in time)';
  }
}

/**
 * The found player's latest deposits ("my online payment did not arrive"): the desk sees the state
 * and never credits an online deposit itself; a supervisor checks it on the SMS rail page.
 */
function RecentDeposits({ playerId, supervisor }: { playerId: string; supervisor: boolean }) {
  const { data, error, loading } = useFetch<CashierDepositsResponse>(
    `/admin/cashier/players/${playerId}/deposits`,
  );
  const trouble = (data?.deposits ?? []).some((d) => d.flagged || d.status !== 'succeeded');
  return (
    <section data-testid="cashier-deposits">
      <h3>Recent deposits</h3>
      <Loading loading={loading && data === null} error={error} />
      {data !== null && data.deposits.length === 0 && <p className="muted small">None yet.</p>}
      {data !== null && data.deposits.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>How</th>
              <th>Amount</th>
              <th>State</th>
              <th>Ref.</th>
            </tr>
          </thead>
          <tbody>
            {data.deposits.map((d) => (
              <tr key={d.id}>
                <td>{formatDateTime(d.createdAt)}</td>
                <td>{d.provider}</td>
                <td>{formatEtb(d.amount)}</td>
                <td>{depositState(d)}</td>
                <td>{d.reference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {trouble && (
        <p className="muted small">
          A payment the player made online and that is not credited is never paid in cash here: a
          supervisor checks it{supervisor ? ' ' : '.'}
          {supervisor && (
            <>
              on the <Link href="/sms">SMS rail page</Link> or the{' '}
              <Link href={`/users/${playerId}`}>player page</Link>.
            </>
          )}
        </p>
      )}
    </section>
  );
}

export default function CashierPage() {
  const { data, error, loading, reload } = useFetch<CashierDeskResponse>('/admin/cashier/desk');
  const [closedShift, setClosed] = useState<{
    shift: CashierShiftView;
    operations: CashOperationView[];
  } | null>(null);

  if (data === null) return <Loading loading={loading} error={error} />;
  const shift = data.shift;

  if (closedShift !== null) {
    const closed = closedShift.shift;
    return (
      <>
        <div className="no-print">
          <PageHeader title="Cashier desk" />
          <Notice kind="ok">Shift closed.</Notice>
          {hasVariance(closed.variance) && (
            <Notice>The count differs from the expected cash: {formatEtb(closed.variance)}.</Notice>
          )}
          <p>
            <button type="button" className="primary" onClick={() => window.print()}>
              Print Z report
            </button>{' '}
            <a href={`/cashier/shifts/${closed.id}/report`} target="_blank" rel="noreferrer">
              Print shift report
            </a>{' '}
            <button
              type="button"
              onClick={() => {
                setClosed(null);
                reload();
              }}
            >
              Back to the desk
            </button>
          </p>
        </div>
        <ShiftReport shift={closed} operations={closedShift.operations} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Cashier desk" />
      {error !== null && <Notice>{error}</Notice>}
      {shift === null ? (
        <section>
          <h2>Open shift</h2>
          {data.shops.length === 0 ? (
            <p className="muted">No active shop. Ask an administrator to set one up.</p>
          ) : (
            <OpenShiftForm desk={data} onDone={reload} />
          )}
        </section>
      ) : (
        <>
          <section className="card" data-testid="shift-summary">
            <h2>{shift.shopName}</h2>
            <p className="muted small">
              Opened {formatDateTime(shift.openedAt)} · opening float{' '}
              {formatEtb(shift.openingFloat)}
            </p>
            <p>
              Deposits {shift.deposits.count} · {formatEtb(shift.deposits.total)} · Withdrawals{' '}
              {formatEtb(shift.withdrawals.total)}
            </p>
            <p>
              Expected cash in the drawer: <strong>{formatEtb(shift.expectedCash)}</strong>
            </p>
            <CloseShiftForm
              shift={shift}
              onClosed={(s) => {
                // Kept here: after the reload the desk no longer lists the closed shift's receipts.
                setClosed({ shift: s, operations: data.operations });
                reload();
              }}
            />
          </section>
          <PlayerDesk desk={data} shift={shift} onDeposit={reload} />
          <Operations desk={data} />
        </>
      )}
    </>
  );
}

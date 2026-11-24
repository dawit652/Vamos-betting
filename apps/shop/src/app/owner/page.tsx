'use client';

import type {
  AgentCashierView,
  AgentStatementListResponse,
  CashierShopView,
  ShopOwnerCashierResponse,
  ShopOwnerCreateCashierRequest,
  ShopOwnerResponse,
} from '@vamos/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { api } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb } from '@/lib/format';
import { TEXT } from '@/lib/text';
import { topUpState } from '@/lib/topup';

/** The agent owner's read-only overview: the agent's shops, cashiers and devices. */
export default function OwnerPage() {
  const owner = useFetch<ShopOwnerResponse>('/shop/owner');
  const statements = useFetch<AgentStatementListResponse>('/shop/owner/statements');
  const router = useRouter();
  const needsPassword = owner.error === TEXT.passwordChangeRequired;
  // The API refuses with 403 password_change_required until the generated password is replaced.
  useEffect(() => {
    if (needsPassword) router.replace('/password');
  }, [needsPassword, router]);

  if (owner.data === null) {
    return (
      <div className="card">
        {owner.error === null ? (
          <p className="muted" role="status">
            {TEXT.loading}
          </p>
        ) : (
          <p className="error" role="alert">
            {owner.error}
          </p>
        )}
      </div>
    );
  }
  const { agent, balance, balanceLowAt, shops, cashiers, devices } = owner.data;
  const balanceState = topUpState(balance, balanceLowAt ?? null);
  return (
    <>
      <h1>{TEXT.ownerTitle}</h1>
      <div className="card">
        <p>
          {TEXT.ownerAgent}:{' '}
          <strong>
            {agent.number} · {agent.name}
          </strong>
        </p>
        <p>
          {TEXT.ownerStatus}: {agent.status === 'active' ? TEXT.statusActive : TEXT.statusBlocked}
        </p>
        <p>
          {TEXT.ownerBalance}: <strong data-testid="owner-balance">{formatEtb(balance)}</strong>
        </p>
        {balanceState === 'empty' ? (
          <p className="error" role="alert" data-testid="owner-balance-empty">
            {TEXT.ownerBalanceEmpty}
          </p>
        ) : balanceState === 'low' ? (
          <p className="topup-warning" role="status" data-testid="owner-balance-low">
            {TEXT.ownerBalanceLow}
          </p>
        ) : null}
        <p className="muted small">{TEXT.ownerBalanceNote}</p>
      </div>

      <h2>
        {TEXT.ownerShops} ({shops.length})
      </h2>
      <div className="table-wrap">
        <table data-testid="owner-shops">
          <thead>
            <tr>
              <th>{TEXT.colShop}</th>
              <th>{TEXT.colName}</th>
              <th>{TEXT.colAddress}</th>
              <th>{TEXT.colStatus}</th>
            </tr>
          </thead>
          <tbody>
            {shops.map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                <td>{s.name}</td>
                <td>{s.address}</td>
                <td>{s.active ? TEXT.shopOpen : TEXT.shopClosed}</td>
              </tr>
            ))}
            {shops.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {TEXT.noneYet}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>
        {TEXT.ownerCashiers} ({cashiers.length})
      </h2>
      <div className="table-wrap">
        <table data-testid="owner-cashiers">
          <thead>
            <tr>
              <th>{TEXT.colName}</th>
              <th>{TEXT.colPhone}</th>
              <th>{TEXT.colShop}</th>
              <th>{TEXT.colStatus}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cashiers.map((c) => (
              <tr key={c.staffId} data-testid="owner-cashier-row">
                <td>{c.displayName}</td>
                <td>{c.phone}</td>
                <td>{c.shopLabel}</td>
                <td>{c.disabledAt === null ? TEXT.accountActive : TEXT.accountDisabled}</td>
                <td>
                  <CashierToggle cashier={c} onDone={owner.reload} />
                </td>
              </tr>
            ))}
            {cashiers.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {TEXT.noneYet}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <AddCashier shops={shops} onDone={owner.reload} />

      <h2>
        {TEXT.ownerDevices} ({devices.length})
      </h2>
      <p className="muted small">{TEXT.ownerDevicesNote}</p>
      <div className="table-wrap">
        <table data-testid="owner-devices">
          <thead>
            <tr>
              <th>{TEXT.colDevice}</th>
              <th>{TEXT.colShop}</th>
              <th>{TEXT.colStatus}</th>
              <th>{TEXT.colAsked}</th>
              <th>{TEXT.colLastSeen}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.label}</td>
                <td>{d.shopLabel}</td>
                <td>{TEXT.deviceStatus[d.status] ?? d.status}</td>
                <td>{formatDateTime(d.requestedAt)}</td>
                <td>{d.lastSeenAt === null ? '—' : formatDateTime(d.lastSeenAt)}</td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {TEXT.noneYet}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>{TEXT.ownerStatements}</h2>
      <p className="muted small">{TEXT.ownerStatementsNote}</p>
      {statements.error !== null && (
        <p className="error" role="alert">
          {statements.error}
        </p>
      )}
      <div className="table-wrap">
        <table data-testid="owner-statements">
          <thead>
            <tr>
              <th>{TEXT.colWeek}</th>
              <th>{TEXT.colSold}</th>
              <th>{TEXT.colCancelled}</th>
              <th>{TEXT.colGgr}</th>
              <th>{TEXT.colPaidOut}</th>
              <th>{TEXT.colCommission}</th>
              <th>{TEXT.colStatus}</th>
            </tr>
          </thead>
          <tbody>
            {(statements.data?.items ?? []).map((s) => (
              <tr key={s.id}>
                <td>{s.weekStart}</td>
                <td>{formatEtb(s.soldStakes)}</td>
                <td>{formatEtb(s.cancelledStakes)}</td>
                <td>{formatEtb(s.ggr)}</td>
                <td>{formatEtb(s.paidAmount)}</td>
                <td>{formatEtb(s.commission)}</td>
                <td>
                  {s.paidAt === null
                    ? TEXT.commissionUnpaid
                    : `${TEXT.commissionPaid} ${formatDateTime(s.paidAt)}`}
                </td>
              </tr>
            ))}
            {statements.data !== null && statements.data.items.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {TEXT.noStatementsYet}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Block or unblock one cashier (after a confirm); the list reloads on success. */
function CashierToggle({ cashier, onDone }: { cashier: AgentCashierView; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = cashier.disabledAt !== null;
  async function toggle() {
    const question = blocked
      ? TEXT.ownerUnblockConfirm(cashier.displayName)
      : TEXT.ownerBlockConfirm(cashier.displayName);
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api<ShopOwnerCashierResponse>(
        `/shop/owner/cashiers/${cashier.staffId}/${blocked ? 'unblock' : 'block'}`,
        { method: 'POST', body: {} },
      );
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        data-testid={blocked ? 'owner-cashier-unblock' : 'owner-cashier-block'}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {blocked ? TEXT.ownerUnblock : TEXT.ownerBlock}
      </button>
      {error !== null && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** The owner's form for a new cashier of one of their shops. */
function AddCashier({ shops, onDone }: { shops: CashierShopView[]; onDone: () => void }) {
  const [shopId, setShopId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const chosenShop = shopId !== '' ? shopId : (shops[0]?.id ?? '');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (chosenShop === '') return;
    const body: ShopOwnerCreateCashierRequest = {
      shopId: chosenShop,
      email: email.trim(),
      displayName: displayName.trim(),
      phone: phone.trim(),
      password,
    };
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api<ShopOwnerCashierResponse>('/shop/owner/cashiers', { method: 'POST', body });
      setDisplayName('');
      setEmail('');
      setPhone('');
      setPassword('');
      setDone(true);
      onDone();
    } catch (e) {
      setError(describeError(e, TEXT.ownerCashierErrors));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="owner-add-cashier-title">
      <h3 id="owner-add-cashier-title">{TEXT.ownerAddCashier}</h3>
      <p className="muted small">{TEXT.ownerAddCashierNote}</p>
      {shops.length === 0 ? (
        <p className="muted">{TEXT.ownerNeedShop}</p>
      ) : (
        <form
          method="post"
          data-testid="owner-add-cashier"
          aria-label={TEXT.ownerAddCashier}
          onSubmit={(e) => void submit(e)}
        >
          <label htmlFor="owner-cashier-shop">
            {TEXT.ownerCashierShop}
            <select
              id="owner-cashier-shop"
              data-testid="owner-cashier-shop"
              value={chosenShop}
              onChange={(e) => setShopId(e.target.value)}
            >
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label} · {s.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="owner-cashier-name">
            {TEXT.ownerCashierName}
            <input
              id="owner-cashier-name"
              data-testid="owner-cashier-name"
              autoComplete="off"
              minLength={2}
              maxLength={100}
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </label>
          <label htmlFor="owner-cashier-email">
            {TEXT.ownerCashierEmail}
            <input
              id="owner-cashier-email"
              data-testid="owner-cashier-email"
              type="email"
              autoComplete="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label htmlFor="owner-cashier-phone">
            {TEXT.ownerCashierPhone}
            <input
              id="owner-cashier-phone"
              data-testid="owner-cashier-phone"
              inputMode="tel"
              autoComplete="off"
              minLength={9}
              maxLength={20}
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <label htmlFor="owner-cashier-password">
            {TEXT.ownerCashierPassword}
            <input
              id="owner-cashier-password"
              data-testid="owner-cashier-password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={12}
              maxLength={200}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label htmlFor="owner-cashier-show">
            <input
              id="owner-cashier-show"
              type="checkbox"
              checked={show}
              onChange={(e) => setShow(e.target.checked)}
            />{' '}
            {TEXT.ownerShowPassword}
          </label>
          {error !== null && (
            <p className="error" role="alert" data-testid="owner-cashier-error">
              {error}
            </p>
          )}
          {done && (
            <p className="notice" role="status">
              {TEXT.ownerCashierAdded}
            </p>
          )}
          <button
            type="submit"
            className="primary"
            data-testid="owner-cashier-submit"
            disabled={busy}
          >
            {TEXT.ownerCashierAdd}
          </button>
        </form>
      )}
    </section>
  );
}

'use client';

import type {
  CashierShiftListResponse,
  CashierShopListResponse,
  CashierShopView,
  CashierStaffListResponse,
  ShopSummaryResponse,
  DeskPinResetListResponse,
} from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useFetch } from '@/components/hooks';
import { useSession } from '@/components/session';
import { Badge, Loading, Notice, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { hasVariance } from '@/lib/cashier';
import { describeError } from '@/lib/errors';
import { formatDateTime, formatEtb, formatSantim, parseEtbToSantim } from '@/lib/format';

function ShopForm({ shop, onSaved }: { shop: CashierShopView; onSaved: () => void }) {
  const [name, setName] = useState(shop.name);
  const [address, setAddress] = useState(shop.address);
  const [width, setWidth] = useState<58 | 80>(shop.receiptWidthMm);
  const [threshold, setThreshold] = useState(formatSantim(shop.approvalThreshold));
  const [active, setActive] = useState(shop.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const approvalThreshold = parseEtbToSantim(threshold);
    if (approvalThreshold === null || approvalThreshold === '0') {
      return setError('Enter the approval threshold in ETB.');
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/cashier/shops/${shop.id}`, {
        method: 'PUT',
        body: { name, address, receiptWidthMm: width, approvalThreshold, active },
      });
      onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <input aria-label="Shop name" value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="Address" value={address} onChange={(e) => setAddress(e.target.value)} />
      <select
        aria-label="Receipt width"
        value={width}
        onChange={(e) => setWidth(e.target.value === '58' ? 58 : 80)}
      >
        <option value={80}>80 mm</option>
        <option value={58}>58 mm</option>
      </select>
      <input
        aria-label="Approval threshold (ETB)"
        inputMode="decimal"
        value={threshold}
        onChange={(e) => setThreshold(e.target.value)}
      />
      <label className="small">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
        Active
      </label>
      <button type="submit" disabled={busy}>
        Save
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

/** Adds a shop: a short code for receipts and reports (bole-02), its name and address. */
function NewShopForm({ onSaved }: { onSaved: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [width, setWidth] = useState<58 | 80>(80);
  const [threshold, setThreshold] = useState('10000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const approvalThreshold = parseEtbToSantim(threshold);
    if (!/^[a-z0-9-]{2,32}$/.test(code.trim().toLowerCase())) {
      return setError('The code is 2 to 32 letters, digits or -, for example bole-02.');
    }
    if (approvalThreshold === null || approvalThreshold === '0') {
      return setError('Enter the approval threshold in ETB.');
    }
    setBusy(true);
    setError(null);
    try {
      await api('/admin/cashier/shops', {
        method: 'POST',
        body: { code, name, address, receiptWidthMm: width, approvalThreshold },
      });
      setCode('');
      setName('');
      setAddress('');
      onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)} aria-label="Add a shop">
      <input
        aria-label="New shop code"
        placeholder="code (bole-02)"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <input
        aria-label="New shop name"
        placeholder="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        aria-label="New shop address"
        placeholder="address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />
      <select
        aria-label="New shop receipt width"
        value={width}
        onChange={(e) => setWidth(e.target.value === '58' ? 58 : 80)}
      >
        <option value={80}>80 mm</option>
        <option value={58}>58 mm</option>
      </select>
      <input
        aria-label="New shop approval threshold (ETB)"
        inputMode="decimal"
        value={threshold}
        onChange={(e) => setThreshold(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        Add shop
      </button>
      {error !== null && <Notice>{error}</Notice>}
    </form>
  );
}

/**
 * Which shop each cashier works at: with more than one active shop, a cashier must be assigned
 * before opening a shift, and opens shifts only there.
 */
function Cashiers({ shops }: { shops: CashierShopView[] }) {
  const { data, error, loading, reload } =
    useFetch<CashierStaffListResponse>('/admin/cashier/staff');
  const [failure, setFailure] = useState<string | null>(null);
  const assign = async (staffId: string, shopId: string) => {
    setFailure(null);
    try {
      await api(`/admin/cashier/staff/${staffId}/shop`, {
        method: 'PUT',
        body: { shopId: shopId === '' ? null : shopId },
      });
      reload();
    } catch (e) {
      setFailure(describeError(e));
    }
  };
  return (
    <section>
      <h2>Cashiers</h2>
      <Loading loading={loading && data === null} error={error} />
      {failure !== null && <Notice>{failure}</Notice>}
      {data !== null && data.staff.length === 0 && (
        <p className="small">No cashier accounts yet (pnpm admin:create with role cashier).</p>
      )}
      {data !== null && data.staff.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Cashier</th>
              <th>Shop</th>
            </tr>
          </thead>
          <tbody>
            {data.staff.map((person) => (
              <tr key={person.id}>
                <td>
                  {person.name} <span className="small">{person.email}</span>
                </td>
                <td>
                  <select
                    aria-label={`Shop of ${person.name}`}
                    value={person.shopId ?? ''}
                    onChange={(e) => void assign(person.id, e.target.value)}
                  >
                    <option value="">Not assigned</option>
                    {shops
                      .filter((shop) => shop.active || shop.id === person.shopId)
                      .map((shop) => (
                        <option key={shop.id} value={shop.id}>
                          {shop.code} · {shop.name}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Shops() {
  const { data, error, loading, reload } =
    useFetch<CashierShopListResponse>('/admin/cashier/shops');
  return (
    <section>
      <h2>Shops{data ? ` (${data.shops.length})` : ''}</h2>
      <NewShopForm onSaved={reload} />
      <Loading loading={loading && data === null} error={error} />
      {data?.shops.map((shop) => (
        <ShopForm key={`${shop.id}-${shop.name}-${shop.address}`} shop={shop} onSaved={reload} />
      ))}
      {data !== null && <Cashiers shops={data.shops} />}
    </section>
  );
}

/** PIN resets the desks asked (ID checked): a supervisor approves or rejects, never their own. */
function PinResetsWaiting() {
  const { data, error, loading, reload } = useFetch<DeskPinResetListResponse>(
    '/admin/cashier/pin-resets',
  );
  const [failure, setFailure] = useState<string | null>(null);
  const decide = async (id: string, approve: boolean) => {
    setFailure(null);
    try {
      await api(`/admin/cashier/pin-resets/${id}/decision`, { method: 'POST', body: { approve } });
      reload();
    } catch (e) {
      setFailure(describeError(e));
    }
  };
  const waiting = (data?.resets ?? []).filter((r) => r.status === 'requested');
  return (
    <section data-testid="pin-resets-waiting">
      <h2>PIN resets waiting ({waiting.length})</h2>
      <Loading loading={loading && data === null} error={error} />
      {failure !== null && <Notice>{failure}</Notice>}
      {waiting.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Asked</th>
              <th>Player</th>
              <th>By</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {waiting.map((r) => (
              <tr key={r.id}>
                <td>{formatDateTime(r.createdAt)}</td>
                <td>{r.playerPhone}</td>
                <td>{r.requestedByName}</td>
                <td>
                  <button type="button" onClick={() => void decide(r.id, true)}>
                    Approve
                  </button>{' '}
                  <button type="button" onClick={() => void decide(r.id, false)}>
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Every shop's cash on one day, in one table (the owner runs more than 40 shops). */
function ShopDay() {
  const [day, setDay] = useState('');
  const { data, error, loading } = useFetch<ShopSummaryResponse>(
    '/admin/cashier/shops/summary',
    day === '' ? {} : { day },
  );
  return (
    <section>
      <h2>Shops on {data?.day ?? 'today'}</h2>
      <label className="small">
        Day{' '}
        <input type="date" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)} />
      </label>
      <Loading loading={loading && data === null} error={error} />
      {data !== null && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Shop</th>
                <th>Open shifts</th>
                <th>Deposits</th>
                <th>Withdrawals</th>
                <th>Net cash in</th>
              </tr>
            </thead>
            <tbody>
              {data.shops.map((shop) => (
                <tr key={shop.shopId}>
                  <td>
                    {shop.code} · {shop.name} {!shop.active && <Badge value="closed" tone="warn" />}
                  </td>
                  <td>{shop.openShifts}</td>
                  <td>
                    {shop.deposits.count} · {formatEtb(shop.deposits.total)}
                  </td>
                  <td>
                    {shop.withdrawals.count} · {formatEtb(shop.withdrawals.total)}
                  </td>
                  <td>{formatEtb(shop.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function CashShiftsPage() {
  const { can } = useSession();
  const { data, error, loading } = useFetch<CashierShiftListResponse>('/admin/cashier/shifts', {
    limit: 100,
  });
  return (
    <>
      <PageHeader title="Cash shifts" />
      {can('users.status') && <PinResetsWaiting />}
      <ShopDay />
      {can('settings.edit') && <Shops />}
      <h2>Shifts</h2>
      <Loading loading={loading && data === null} error={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Shop</th>
              <th>Staff</th>
              <th>Opened</th>
              <th>Closed</th>
              <th>Status</th>
              <th className="num">Float</th>
              <th className="num">Deposits</th>
              <th className="num">Withdrawals</th>
              <th className="num">Expected</th>
              <th className="num">Counted</th>
              <th className="num">Variance</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {data?.shifts.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/cashier/shifts/${s.id}`}>{s.shopName}</Link>
                </td>
                <td>{s.staffName}</td>
                <td>{formatDateTime(s.openedAt)}</td>
                <td>{formatDateTime(s.closedAt)}</td>
                <td>
                  <Badge value={s.status} />
                </td>
                <td className="num">{formatEtb(s.openingFloat)}</td>
                <td className="num">
                  {s.deposits.count} · {formatEtb(s.deposits.total)}
                </td>
                <td className="num">
                  {s.withdrawals.count} · {formatEtb(s.withdrawals.total)}
                </td>
                <td className="num">{formatEtb(s.expectedCash)}</td>
                <td className="num">{formatEtb(s.countedCash)}</td>
                <td className={`num${hasVariance(s.variance) ? ' variance-bad' : ''}`}>
                  {formatEtb(s.variance)}
                </td>
                <td>{s.closeNote ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data !== null && data.shifts.length === 0 && <p className="muted">No shifts yet.</p>}
    </>
  );
}

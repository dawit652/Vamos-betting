'use client';

import type {
  CashierShiftListResponse,
  CashierShopListResponse,
  CashierShopView,
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

function Shops() {
  const { data, error, loading, reload } =
    useFetch<CashierShopListResponse>('/admin/cashier/shops');
  return (
    <section>
      <h2>Shops</h2>
      <Loading loading={loading && data === null} error={error} />
      {data?.shops.map((shop) => (
        <ShopForm key={`${shop.id}-${shop.name}-${shop.address}`} shop={shop} onSaved={reload} />
      ))}
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

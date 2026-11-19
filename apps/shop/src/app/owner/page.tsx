'use client';

import type { ShopOwnerResponse } from '@vamos/contracts';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useFetch } from '@/components/hooks';
import { formatDateTime, formatEtb } from '@/lib/format';
import { TEXT } from '@/lib/text';

/** The agent owner's read-only overview: the agent's shops, cashiers and devices. */
export default function OwnerPage() {
  const owner = useFetch<ShopOwnerResponse>('/shop/owner');
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
  const { agent, balance, shops, cashiers, devices } = owner.data;
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
            </tr>
          </thead>
          <tbody>
            {cashiers.map((c) => (
              <tr key={c.staffId}>
                <td>{c.displayName}</td>
                <td>{c.phone}</td>
                <td>{c.shopLabel}</td>
                <td>{c.disabledAt === null ? TEXT.accountActive : TEXT.accountDisabled}</td>
              </tr>
            ))}
            {cashiers.length === 0 && (
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
    </>
  );
}

'use client';

import type { PlayerSummaryView } from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { usePaged } from '@/components/hooks';
import { Badge, Field, LoadMore, Loading, PageHeader } from '@/components/ui';
import { formatDateTime, formatEtb } from '@/lib/format';

export default function UsersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ q: '', status: '' });
  const list = usePaged<PlayerSummaryView>('/admin/users', {
    q: applied.q,
    status: applied.status,
  });

  function search(event: FormEvent) {
    event.preventDefault();
    setApplied({ q, status });
  }

  return (
    <>
      <PageHeader title="Players" />
      <form className="row" onSubmit={search}>
        <Field label="Phone, name or user id">
          <input value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {['pending_verification', 'active', 'suspended', 'closed'].map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" className="primary">
          Search
        </button>
      </form>
      <Loading loading={list.loading && list.items.length === 0} error={list.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Phone</th>
              <th>Name</th>
              <th>Status</th>
              <th>KYC</th>
              <th className="num">Cash</th>
              <th className="num">Bonus</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={`/users/${p.id}`}>{p.phone}</Link>
                </td>
                <td>{p.fullName ?? '–'}</td>
                <td>
                  <Badge value={p.status} />
                </td>
                <td>
                  <Badge value={p.kycStatus} />
                </td>
                <td className="num">{formatEtb(p.cash)}</td>
                <td className="num">{formatEtb(p.bonus)}</td>
                <td>{formatDateTime(p.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}

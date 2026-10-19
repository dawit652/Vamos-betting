'use client';

import type { StaffBetDetailView, StaffBetSummaryView } from '@vamos/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { useFetch, usePaged } from '@/components/hooks';
import { Badge, Field, LoadMore, Loading, PageHeader } from '@/components/ui';
import { channelLabel } from '@/lib/channels';
import { dayToIso, formatDateTime, formatEtb, formatOdds } from '@/lib/format';

const STATUSES = ['pending_acceptance', 'open', 'won', 'lost', 'void', 'cashed_out', 'rejected'];

function BetDetail({ id }: { id: string }) {
  const { data, error, loading } = useFetch<StaffBetDetailView>(`/admin/bets/${id}`);
  return (
    <>
      <Loading loading={loading} error={error} />
      {data !== null && <pre className="small">{JSON.stringify(data, null, 1)}</pre>}
    </>
  );
}

function BetsInner() {
  const params = useSearchParams();
  const [shortId, setShortId] = useState(params.get('shortId') ?? '');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [applied, setApplied] = useState({
    shortId: params.get('shortId') ?? '',
    phone: '',
    status: '',
    from: '',
    to: '',
  });
  const [open, setOpen] = useState<string | null>(null);
  const list = usePaged<StaffBetSummaryView>('/admin/bets', applied);

  function search(event: FormEvent) {
    event.preventDefault();
    setApplied({
      shortId,
      phone,
      status,
      from: fromDay === '' ? '' : (dayToIso(fromDay) ?? ''),
      to: toDay === '' ? '' : (dayToIso(toDay, true) ?? ''),
    });
  }

  return (
    <>
      <PageHeader title="Bets" />
      <form className="row" onSubmit={search}>
        <Field label="Bet ID">
          <input value={shortId} onChange={(e) => setShortId(e.target.value)} />
        </Field>
        <Field label="Player phone">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
        </Field>
        <Field label="To (inclusive)">
          <input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} />
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
              <th>Bet</th>
              <th>Player</th>
              <th>Type</th>
              <th>Channel</th>
              <th>Status</th>
              <th className="num">Stake</th>
              <th className="num">Odds</th>
              <th className="num">Potential net</th>
              <th className="num">Settled net</th>
              <th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((b) => (
              <tr key={b.id}>
                <td>
                  <button type="button" onClick={() => setOpen(open === b.id ? null : b.id)}>
                    {b.shortId}
                  </button>
                  {open === b.id && <BetDetail id={b.id} />}
                </td>
                <td>
                  <Link href={`/users/${b.userId}`}>{b.phone}</Link>
                </td>
                <td>
                  {b.betType} ({b.legCount})
                </td>
                <td>{channelLabel(b.channel)}</td>
                <td>
                  <Badge value={b.status} />
                </td>
                <td className="num">{formatEtb(b.stake)}</td>
                <td className="num">{formatOdds(b.totalOddsMilli)}</td>
                <td className="num">{formatEtb(b.potentialNetPayout)}</td>
                <td className="num">{formatEtb(b.settledNetPayout)}</td>
                <td>{formatDateTime(b.placedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}

export default function BetsPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <BetsInner />
    </Suspense>
  );
}

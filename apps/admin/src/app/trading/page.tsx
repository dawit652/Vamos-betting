'use client';

import type { TradingEventSummaryView } from '@vamos/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { usePaged } from '@/components/hooks';
import { Badge, Field, LoadMore, Loading, PageHeader } from '@/components/ui';
import { formatDateTime, formatEtb, nameOf } from '@/lib/format';

const STATUSES = ['scheduled', 'live', 'finished', 'cancelled', 'postponed', 'abandoned'];

export default function TradingPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ q: '', status: '' });
  const list = usePaged<TradingEventSummaryView>('/admin/trading/events', applied);

  function search(event: FormEvent) {
    event.preventDefault();
    setApplied({ q, status });
  }

  return (
    <>
      <PageHeader title="Trading" />
      <form className="row" onSubmit={search}>
        <Field label="Team, competition or Game ID">
          <input value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
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
              <th>Game</th>
              <th>Match</th>
              <th>Competition</th>
              <th>Start</th>
              <th>Status</th>
              <th className="num">Markets (open/susp./void)</th>
              <th className="num">Open bets</th>
              <th className="num">Open stake</th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((e) => (
              <tr key={e.id}>
                <td>{e.gameId}</td>
                <td>
                  <Link href={`/trading/${e.id}`}>
                    {nameOf(e.homeTeam)} v {nameOf(e.awayTeam)}
                  </Link>
                </td>
                <td>{nameOf(e.competition)}</td>
                <td>{formatDateTime(e.startTime)}</td>
                <td>
                  <Badge value={e.status} />
                  {!e.bettingOpen && <Badge value="betting off" tone="warn" />}
                  {e.topMatch && <Badge value="top match" />}
                </td>
                <td className="num">
                  {e.markets.total} ({e.markets.open}/{e.markets.suspended}/{e.markets.voided})
                </td>
                <td className="num">{e.openBets}</td>
                <td className="num">{formatEtb(e.openStake)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={list.hasMore} loading={list.loading} onMore={list.loadMore} />
    </>
  );
}

'use client';

import type { SelectionLiabilityView, StaffBetSummaryView } from '@vamos/contracts';
import Link from 'next/link';
import { useFetch, usePaged } from '@/components/hooks';
import { Badge, LoadMore, Loading, PageHeader } from '@/components/ui';
import { formatDateTime, formatEtb, formatOdds, nameOf } from '@/lib/format';

export default function RiskPage() {
  const liabilities = useFetch<{ items: SelectionLiabilityView[] }>('/admin/risk/liabilities', {
    limit: 50,
  });
  const big = usePaged<StaffBetSummaryView>('/admin/risk/big-bets');

  return (
    <>
      <PageHeader title="Risk" />
      <h2>Liability per selection (open bets)</h2>
      <Loading
        loading={liabilities.loading && liabilities.data === null}
        error={liabilities.error}
      />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Match</th>
              <th>Market</th>
              <th>Selection</th>
              <th className="num">Odds</th>
              <th className="num">Bets</th>
              <th className="num">Stake</th>
              <th className="num">Liability</th>
            </tr>
          </thead>
          <tbody>
            {liabilities.data?.items.map((l) => (
              <tr key={l.selectionId}>
                <td>
                  <Link href={`/trading/${l.eventId}`}>
                    {nameOf(l.homeTeam)} v {nameOf(l.awayTeam)}
                  </Link>
                </td>
                <td>
                  {l.marketKey} <Badge value={l.marketStatus} />
                </td>
                <td>{l.code}</td>
                <td className="num">{formatOdds(l.oddsMilli)}</td>
                <td className="num">{l.bets}</td>
                <td className="num">{formatEtb(l.stake)}</td>
                <td className="num">{formatEtb(l.liability)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Big open bets</h2>
      <Loading loading={big.loading && big.items.length === 0} error={big.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Bet</th>
              <th>Player</th>
              <th>Type</th>
              <th className="num">Stake</th>
              <th className="num">Odds</th>
              <th className="num">Potential payout</th>
              <th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {big.items.map((b) => (
              <tr key={b.id}>
                <td>
                  <Link href={`/bets?shortId=${b.shortId}`}>{b.shortId}</Link>
                </td>
                <td>
                  <Link href={`/users/${b.userId}`}>{b.phone}</Link>
                </td>
                <td>
                  {b.betType} ({b.legCount})
                </td>
                <td className="num">{formatEtb(b.stake)}</td>
                <td className="num">{formatOdds(b.totalOddsMilli)}</td>
                <td className="num">{formatEtb(b.potentialGrossPayout)}</td>
                <td>{formatDateTime(b.placedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={big.hasMore} loading={big.loading} onMore={big.loadMore} />
    </>
  );
}

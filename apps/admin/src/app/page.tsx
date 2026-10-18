'use client';

import type { DashboardResponse } from '@vamos/contracts';
import { useState } from 'react';
import { Field, Loading, PageHeader, Stat } from '@/components/ui';
import { useFetch } from '@/components/hooks';
import { dayToIso, formatEtb, toDay } from '@/lib/format';

export default function DashboardPage() {
  const [fromDay, setFromDay] = useState(() => toDay(new Date(Date.now() - 6 * 86_400_000)));
  const [toDayValue, setToDayValue] = useState(() => toDay(new Date()));
  const from = dayToIso(fromDay);
  const to = dayToIso(toDayValue, true);
  const { data, error, loading } = useFetch<DashboardResponse>(
    from !== null && to !== null ? '/admin/dashboard' : null,
    { from, to },
  );

  return (
    <>
      <PageHeader title="Dashboard">
        <Field label="From">
          <input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
        </Field>
        <Field label="To (inclusive)">
          <input type="date" value={toDayValue} onChange={(e) => setToDayValue(e.target.value)} />
        </Field>
      </PageHeader>
      <Loading loading={loading && data === null} error={error} />
      {data !== null && (
        <>
          <h2>Betting</h2>
          <div className="stats">
            <Stat
              label="Turnover"
              value={formatEtb(data.betting.turnover)}
              hint={`${data.betting.placed.count} bets placed`}
            />
            <Stat
              label="GGR"
              value={formatEtb(data.betting.ggr)}
              hint={`${data.betting.settled.count} net settlements`}
            />
            <Stat label="Payouts" value={formatEtb(data.betting.payouts)} />
            <Stat label="Tax withheld" value={formatEtb(data.betting.taxWithheld)} />
          </div>
          <h2>Open liabilities (now)</h2>
          <div className="stats">
            <Stat label="Open bets" value={data.openLiabilities.bets} />
            <Stat label="Open stakes" value={formatEtb(data.openLiabilities.stakes)} />
            <Stat
              label="Potential payout"
              value={formatEtb(data.openLiabilities.potentialPayout)}
            />
            <Stat
              label="Potential net payout"
              value={formatEtb(data.openLiabilities.potentialNetPayout)}
            />
          </div>
          <h2>Payments</h2>
          <div className="stats">
            <Stat
              label="Deposits"
              value={formatEtb(data.payments.deposits.amount)}
              hint={`${data.payments.deposits.count} deposits`}
            />
            <Stat
              label="Withdrawals"
              value={formatEtb(data.payments.withdrawals.amount)}
              hint={`${data.payments.withdrawals.count} paid`}
            />
            <Stat
              label="Open withdrawals"
              value={formatEtb(data.payments.openWithdrawals.amount)}
              hint={`${data.payments.awaitingReview} awaiting review`}
            />
            <Stat
              label="Flagged"
              value={data.payments.flaggedWithdrawals + data.payments.flaggedDeposits}
              hint={`${data.payments.flaggedWithdrawals} withdrawals, ${data.payments.flaggedDeposits} deposits`}
            />
          </div>
          <h2>Jackpots</h2>
          <div className="stats">
            <Stat
              label="Entries"
              value={formatEtb(data.jackpots.entries.amount)}
              hint={`${data.jackpots.entries.count} entries`}
            />
            <Stat label="Prizes" value={formatEtb(data.jackpots.prizes)} />
            <Stat label="Refunds" value={formatEtb(data.jackpots.refunds)} />
            <Stat label="Jackpot GGR" value={formatEtb(data.jackpots.ggr)} />
          </div>
          <h2>Players</h2>
          <div className="stats">
            <Stat label="Registered" value={data.players.registered} />
            <Stat label="Active" value={data.players.active} />
          </div>
        </>
      )}
    </>
  );
}

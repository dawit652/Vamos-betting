'use client';

import type { OwnerReportPeriod, OwnerReportResponse } from '@vamos/contracts';
import { businessDateOf } from '@vamos/core';
import { useState } from 'react';
import { useFetch } from '@/components/hooks';
import { Badge, Loading, PageHeader } from '@/components/ui';
import { formatDateTime, formatEtb } from '@/lib/format';
import { balanceLabel, CHECK_LABELS, reportCsv, shiftReportDate } from '@/lib/reports';

/**
 * Owner reports for a day, a week, a month or a year (docs/plans/owner-reports.md): every figure
 * comes from the ledger, and the report shows the checks it ran on itself.
 */

const PERIODS: ReadonlyArray<{ id: OwnerReportPeriod; label: string }> = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

function downloadCsv(report: OwnerReportResponse) {
  const blob = new Blob([reportCsv(report)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `report-${report.period}-${report.firstDay}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function Checks({ report }: { report: OwnerReportResponse }) {
  const failed = report.checks.filter((c) => !c.ok);
  return (
    <section className="panel" aria-label="Checks" data-testid="report-checks">
      <p>
        {failed.length === 0 ? (
          <Badge value="All checks passed" tone="good" />
        ) : (
          <Badge value={`${failed.length} check(s) failed`} tone="bad" />
        )}
      </p>
      <ul>
        {report.checks.map((check) => (
          <li key={check.id} data-testid={`report-check-${check.id}`}>
            {check.ok ? '✓' : '✗'} {CHECK_LABELS[check.id]}
            {check.detail !== null && <span className="muted small"> ({check.detail})</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function BettingTable({ report }: { report: OwnerReportResponse }) {
  const { online, shop } = report.figures;
  const both = (pick: (c: typeof online) => string) =>
    (BigInt(pick(online)) + BigInt(pick(shop))).toString();
  const rows: Array<[string, (c: typeof online) => string]> = [
    ['Stakes', (c) => c.stakes],
    ['Won payouts (before tax)', (c) => c.wonPayouts],
    ['Cash-outs', (c) => c.cashOuts],
    ['Refunds (void bets)', (c) => c.refunds],
    ['Payouts', (c) => c.payouts],
    ['GGR (stakes − payouts)', (c) => c.ggr],
    ['Winnings tax withheld', (c) => c.taxWithheld],
  ];
  return (
    <div className="table-wrap">
      <table data-testid="report-betting">
        <thead>
          <tr>
            <th>Betting</th>
            <th>Online</th>
            <th>Shops</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Bets</td>
            <td>{online.bets}</td>
            <td>{shop.bets}</td>
            <td>{online.bets + shop.bets}</td>
          </tr>
          {rows.map(([label, pick]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{formatEtb(pick(online))}</td>
              <td>{formatEtb(pick(shop))}</td>
              <td>{formatEtb(both(pick))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Report({ report }: { report: OwnerReportResponse }) {
  const f = report.figures;
  const closedDays = report.days.filter((d) => d.closed).length;
  return (
    <div data-testid="report">
      <p className="muted small">
        {report.firstDay === report.lastDay
          ? report.firstDay
          : `${report.firstDay} to ${report.lastDay}`}{' '}
        (Ethiopian time).{' '}
        {report.open ? `Still running: figures until ${formatDateTime(report.asOf)}.` : 'Finished.'}{' '}
        Days closed: {closedDays} of {report.days.length}.
      </p>
      <Checks report={report} />
      <h2>Summary</h2>
      <div className="table-wrap">
        <table data-testid="report-summary">
          <tbody>
            <tr>
              <td>Total GGR (betting and jackpot)</td>
              <td data-testid="report-total-ggr">{formatEtb(f.totalGgr)}</td>
            </tr>
            <tr>
              <td>Deposits ({f.deposits.count})</td>
              <td data-testid="report-deposits">{formatEtb(f.deposits.total)}</td>
            </tr>
            <tr>
              <td>Withdrawals paid ({f.withdrawals.paidCount})</td>
              <td>{formatEtb(f.withdrawals.paid)}</td>
            </tr>
            <tr>
              <td>Winnings tax withheld</td>
              <td>{formatEtb(f.taxWithheld)}</td>
            </tr>
            <tr>
              <td>Bonuses</td>
              <td>{formatEtb(f.bonuses)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <BettingTable report={report} />
      <h2>Shops</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td>Winning tickets paid at counters ({f.shop.ticketsPaidCount})</td>
              <td>{formatEtb(f.shop.ticketsPaid)}</td>
            </tr>
            <tr>
              <td>Winnings never collected ({f.shop.unclaimedCount})</td>
              <td>{formatEtb(f.shop.unclaimed)}</td>
            </tr>
            <tr>
              <td>Agent top-ups ({f.shop.agentTopupCount})</td>
              <td>{formatEtb(f.shop.agentTopups)}</td>
            </tr>
            <tr>
              <td>Agent take-backs ({f.shop.agentTakeBackCount})</td>
              <td>{formatEtb(f.shop.agentTakeBacks)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>Jackpot</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            <tr>
              <td>Entries ({f.jackpot.entries})</td>
              <td>{formatEtb(f.jackpot.stakes)}</td>
            </tr>
            <tr>
              <td>Refunds</td>
              <td>{formatEtb(f.jackpot.refunds)}</td>
            </tr>
            <tr>
              <td>Prizes (before tax)</td>
              <td>{formatEtb(f.jackpot.prizes)}</td>
            </tr>
            <tr>
              <td>Result</td>
              <td>{formatEtb(f.jackpot.result)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>Payments</h2>
      <div className="table-wrap">
        <table data-testid="report-payments">
          <thead>
            <tr>
              <th>Line</th>
              <th>Count</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {f.deposits.byProvider.map((p) => (
              <tr key={`d-${p.provider}`}>
                <td>Deposits through {p.provider}</td>
                <td>{p.count}</td>
                <td>{formatEtb(p.amount)}</td>
              </tr>
            ))}
            <tr>
              <td>Withdrawals asked for</td>
              <td>{f.withdrawals.requestedCount}</td>
              <td>{formatEtb(f.withdrawals.requested)}</td>
            </tr>
            {f.withdrawals.paidByProvider.map((p) => (
              <tr key={`w-${p.provider}`}>
                <td>Withdrawals paid through {p.provider}</td>
                <td>{p.count}</td>
                <td>{formatEtb(p.amount)}</td>
              </tr>
            ))}
            <tr>
              <td>Withdrawals given back to players</td>
              <td>{f.withdrawals.returnedCount}</td>
              <td>{formatEtb(f.withdrawals.returned)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>Balances</h2>
      <div className="table-wrap">
        <table data-testid="report-balances">
          <thead>
            <tr>
              <th>Balance</th>
              <th>Opening</th>
              <th>Closing</th>
            </tr>
          </thead>
          <tbody>
            {report.balances.map((b) => (
              <tr key={b.key}>
                <td>{balanceLabel(b.key)}</td>
                <td>{formatEtb(b.opening)}</td>
                <td>{formatEtb(b.closing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.days.length > 1 && (
        <details>
          <summary>Days</summary>
          <ul>
            {report.days.map((d) => (
              <li key={d.date}>
                {d.date}: {d.changed ? '✗ changed after its close' : d.closed ? '✓ closed' : 'open'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const [period, setPeriod] = useState<OwnerReportPeriod>('day');
  const [date, setDate] = useState(() => businessDateOf(new Date()));
  const view = useFetch<OwnerReportResponse>(`/admin/reports?period=${period}&date=${date}`);
  const report = view.data;
  return (
    <>
      <PageHeader title="Reports" />
      <section className="panel" aria-label="Period" style={{ marginBottom: 12 }}>
        <div className="row">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              data-testid={`report-period-${p.id}`}
              aria-pressed={period === p.id}
              onClick={() => setPeriod(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="row">
          <button
            type="button"
            data-testid="report-previous"
            onClick={() => setDate(shiftReportDate(period, date, -1))}
          >
            ◀ Previous
          </button>
          <input
            type="date"
            aria-label="Date"
            data-testid="report-date"
            value={date}
            onChange={(e) => {
              if (e.target.value !== '') setDate(e.target.value);
            }}
          />
          <button
            type="button"
            data-testid="report-next"
            onClick={() => setDate(shiftReportDate(period, date, 1))}
          >
            Next ▶
          </button>
          {report !== null && (
            <button type="button" data-testid="report-csv" onClick={() => downloadCsv(report)}>
              Download CSV
            </button>
          )}
        </div>
      </section>
      <Loading loading={view.loading && report === null} error={view.error} />
      {report !== null && <Report report={report} />}
    </>
  );
}

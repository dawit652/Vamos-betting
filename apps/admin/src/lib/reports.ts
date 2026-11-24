import type { OwnerReportPeriod, OwnerReportResponse } from '@vamos/contracts';
import { addBusinessDays, reportWindow } from '@vamos/core';
import { formatSantim } from './format';

/**
 * The Reports page's helpers (docs/plans/owner-reports.md): moving between periods, readable
 * names for balances and checks, and the CSV.
 */

/** The date of the previous (-1) or next (+1) period of the same kind. */
export function shiftReportDate(period: OwnerReportPeriod, date: string, step: -1 | 1): string {
  const window = reportWindow(period, date);
  return step === 1 ? addBusinessDays(window.lastDay, 1) : addBusinessDays(window.firstDay, -1);
}

const BALANCE_LABELS: Readonly<Record<string, string>> = {
  player_cash: "Players' cash",
  player_bonus: "Players' bonus money",
  house_stakes: 'Open stakes (bets not settled)',
  house_revenue: 'House revenue',
  house_tax_payable: 'Winnings tax to pay',
  house_withdrawals_pending: 'Withdrawals waiting to be paid',
  house_jackpot: 'Jackpot pool',
  house_promotions: 'Promotions',
  house_cash_variance: 'Cash differences at counters',
  house_demo_funding: 'Demo money',
  agent_balance: "Agents' balances",
  house_agent_funding: 'Agent top-ups received',
  house_retail_payable: 'Shop winnings owed',
  house_retail_cash: 'HQ shop cash',
};

/** A readable name for a balance key (`kind` or `house_psp_clearing:<provider>`). */
export function balanceLabel(key: string): string {
  if (key.startsWith('house_psp_clearing:')) {
    return `Payments through ${key.slice('house_psp_clearing:'.length)}`;
  }
  return BALANCE_LABELS[key] ?? key;
}

export const CHECK_LABELS: Readonly<Record<OwnerReportResponse['checks'][number]['id'], string>> = {
  balanced: 'All postings of the period add up to zero',
  every_posting_balanced: 'Every single posting adds up to zero',
  unchanged_since_close: 'Every closed day is unchanged since its close',
  closed_days_passed: 'Every closed day passed its checks when it closed',
  balances_roll_forward: 'Opening balances + movements = closing balances',
};

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The report as CSV: the figures (amounts in ETB), the checks, the balances and the movements. */
export function reportCsv(report: OwnerReportResponse): string {
  const etb = (santim: string) => formatSantim(santim).replaceAll(',', '');
  const f = report.figures;
  const rows: Array<Array<string | number>> = [
    ['Report', `${report.period} ${report.firstDay} to ${report.lastDay}`, '', ''],
    ['Section', 'Line', 'Count', 'Amount (ETB)'],
  ];
  for (const [label, channel] of [
    ['Online', f.online],
    ['Shops', f.shop],
  ] as const) {
    rows.push(
      [label, 'Bets', channel.bets, ''],
      [label, 'Stakes', '', etb(channel.stakes)],
      [label, 'Won payouts (before tax)', '', etb(channel.wonPayouts)],
      [label, 'Cash-outs', '', etb(channel.cashOuts)],
      [label, 'Refunds', '', etb(channel.refunds)],
      [label, 'Payouts', '', etb(channel.payouts)],
      [label, 'GGR', '', etb(channel.ggr)],
      [label, 'Winnings tax withheld', '', etb(channel.taxWithheld)],
    );
  }
  rows.push(
    ['Shops', 'Tickets paid at counters', f.shop.ticketsPaidCount, etb(f.shop.ticketsPaid)],
    ['Shops', 'Winnings never collected', f.shop.unclaimedCount, etb(f.shop.unclaimed)],
    ['Shops', 'Agent top-ups', f.shop.agentTopupCount, etb(f.shop.agentTopups)],
    ['Shops', 'Agent take-backs', f.shop.agentTakeBackCount, etb(f.shop.agentTakeBacks)],
    ['Jackpot', 'Entries', f.jackpot.entries, etb(f.jackpot.stakes)],
    ['Jackpot', 'Refunds', '', etb(f.jackpot.refunds)],
    ['Jackpot', 'Prizes (before tax)', '', etb(f.jackpot.prizes)],
    ['Jackpot', 'Result', '', etb(f.jackpot.result)],
    ['Total', 'GGR', '', etb(f.totalGgr)],
    ['Total', 'Winnings tax withheld', '', etb(f.taxWithheld)],
    ['Payments', 'Deposits', f.deposits.count, etb(f.deposits.total)],
    ...f.deposits.byProvider.map((p) => ['Deposits', p.provider, p.count, etb(p.amount)]),
    [
      'Payments',
      'Withdrawals asked for',
      f.withdrawals.requestedCount,
      etb(f.withdrawals.requested),
    ],
    ['Payments', 'Withdrawals paid', f.withdrawals.paidCount, etb(f.withdrawals.paid)],
    ...f.withdrawals.paidByProvider.map((p) => [
      'Withdrawals paid',
      p.provider,
      p.count,
      etb(p.amount),
    ]),
    [
      'Payments',
      'Withdrawals given back',
      f.withdrawals.returnedCount,
      etb(f.withdrawals.returned),
    ],
    ['Promotions', 'Bonuses', '', etb(f.bonuses)],
  );
  rows.push([], ['Check', 'Result', 'Detail', '']);
  for (const check of report.checks) {
    rows.push([CHECK_LABELS[check.id], check.ok ? 'OK' : 'FAILED', check.detail ?? '', '']);
  }
  rows.push([], ['Balance', 'Opening (ETB)', 'Closing (ETB)', '']);
  for (const b of report.balances)
    rows.push([balanceLabel(b.key), etb(b.opening), etb(b.closing), '']);
  rows.push(
    [],
    [
      'Category',
      'Channel',
      'Account kind',
      'Provider',
      'Ledger type',
      'Transactions',
      'Amount (ETB)',
    ],
  );
  for (const m of report.movements) {
    rows.push([
      m.category,
      m.channel,
      m.kind,
      m.provider ?? '',
      m.type ?? '',
      m.transactions,
      etb(m.amount),
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

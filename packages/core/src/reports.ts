import {
  addBusinessDays,
  businessDatesBetween,
  businessDayWindow,
  businessWeekStartOf,
  isBusinessDate,
} from './businessday';
import type { Santim } from './money';

/**
 * Owner reports for a day, a week, a month and a year (owner, 22 Nov 2026: "Daily, weekly, monthly
 * and yearly reports never make a mistake"; docs/plans/owner-reports.md). Pure part.
 *
 * Every figure comes from the double-entry ledger. The database groups a period's postings (by
 * ledger_transactions.created_at, in Ethiopian time) into ReportTotal rows, one per category,
 * channel, ledger account kind and provider; `summarizeReport` turns them into figures. A figure is
 * always a sum of rows, so a week, a month or a year is exactly the sum of its days
 * (`addReportTotals`; property-tested): they can never disagree.
 *
 * This is the cash view: a stake counts on the day it is accepted, its payout on the day it is
 * settled, and a corrected result on the day the correction is posted (earlier days keep what was
 * posted then). GGR = stakes accepted − payouts (won bets before tax, cash-outs, refunds).
 */

export const REPORT_PERIODS = ['day', 'week', 'month', 'year'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export interface ReportWindow {
  period: ReportPeriod;
  /** The first and the last business date of the period (both included). */
  firstDay: string;
  lastDay: string;
  /** [start, end): the instants the period covers. */
  start: Date;
  end: Date;
  /** Every business date of the period, in order. */
  days: string[];
}

/** The period of kind `period` that contains the business date `date` (YYYY-MM-DD). */
export function reportWindow(period: ReportPeriod, date: string): ReportWindow {
  const valid: boolean = isBusinessDate(date);
  if (!valid) throw new RangeError(`not a business date (YYYY-MM-DD): ${date}`);
  let firstDay: string;
  let lastDay: string;
  switch (period) {
    case 'day':
      firstDay = date;
      lastDay = date;
      break;
    case 'week':
      firstDay = businessWeekStartOf(businessDayWindow(date).start);
      lastDay = addBusinessDays(firstDay, 6);
      break;
    case 'month': {
      const [year, month] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
      firstDay = `${date.slice(0, 7)}-01`;
      const next = month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
      lastDay = addBusinessDays(next, -1);
      break;
    }
    case 'year':
      firstDay = `${date.slice(0, 4)}-01-01`;
      lastDay = `${date.slice(0, 4)}-12-31`;
      break;
    default:
      throw new RangeError(`unknown report period: ${String(period)}`);
  }
  return {
    period,
    firstDay,
    lastDay,
    start: businessDayWindow(firstDay).start,
    end: businessDayWindow(lastDay).end,
    days: businessDatesBetween(firstDay, lastDay),
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Where a posting belongs in a report (the database classifies with the same rules). */
export const REPORT_CATEGORIES = [
  /** `bet_stake`: the player's (online) or the shop's (shop) money −stake, house_stakes +stake. */
  'bet_stake',
  /** `bet_refund` `reject:<betId>`: a live bet refused after its delay, its stake back. */
  'bet_rejection',
  /** `bet_payout` (won or lost) or its `settlement_reversal`. */
  'bet_settlement',
  /** `bet_refund` of a void bet, or its reversal. */
  'bet_void',
  /** `bet_cashout`, or its reversal. */
  'bet_cashout',
  /** `retail_ticket_cancel`: house_stakes −stake, the stake back to the shop. */
  'shop_ticket_cancelled',
  /** `retail_ticket_payout`: house_retail_payable −net, the shop's cash +net. */
  'shop_ticket_paid',
  /** `retail_ticket_expiry`: house_retail_payable −net, house_revenue +net (never collected). */
  'shop_ticket_expired',
  /** `jackpot_entry`: player_cash −cost, house_jackpot +cost. */
  'jackpot_entry',
  /** `jackpot_entry` `jackpot_refund:<entryId>`: the cost back for a void round. */
  'jackpot_refund',
  /** `jackpot_prize`: house_jackpot −gross, player_cash +net, house_tax_payable +tax. */
  'jackpot_prize',
  /** `deposit`: house_psp_clearing (provider) −amount, player_cash +amount. */
  'deposit',
  /** `withdrawal` `…:hold`: player_cash −amount, house_withdrawals_pending +amount. */
  'withdrawal_hold',
  /** `withdrawal` `…:paid`: house_withdrawals_pending −amount, house_psp_clearing +amount. */
  'withdrawal_paid',
  /** `withdrawal_reversal`: house_withdrawals_pending −amount, player_cash +amount. */
  'withdrawal_returned',
  /** `agent_topup`: an agent's balance grows. */
  'agent_topup',
  /** `agent_take_back`: an agent's balance shrinks. */
  'agent_take_back',
  /** `bonus`: a promotion's cost. */
  'bonus',
  /** `adjustment`: corrections, cash variances. */
  'adjustment',
  /** Anything else (demo top-ups, …): listed as it is. */
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_CHANNELS = ['online', 'shop'] as const;
export type ReportChannel = (typeof REPORT_CHANNELS)[number];

/** The category of one ledger transaction. `reversedType`: the type a reversal negates. */
export function classifyReportPosting(tx: {
  type: string;
  idempotencyKey: string;
  reversedType?: string | null;
}): ReportCategory {
  switch (tx.type) {
    case 'bet_stake':
      return 'bet_stake';
    case 'bet_refund':
      return tx.idempotencyKey.startsWith('reject:') ? 'bet_rejection' : 'bet_void';
    case 'bet_payout':
      return 'bet_settlement';
    case 'bet_cashout':
      return 'bet_cashout';
    case 'settlement_reversal':
      if (tx.reversedType === 'bet_refund') return 'bet_void';
      if (tx.reversedType === 'bet_cashout') return 'bet_cashout';
      return 'bet_settlement';
    case 'retail_ticket_cancel':
      return 'shop_ticket_cancelled';
    case 'retail_ticket_payout':
      return 'shop_ticket_paid';
    case 'retail_ticket_expiry':
      return 'shop_ticket_expired';
    case 'jackpot_entry':
      return tx.idempotencyKey.startsWith('jackpot_refund:') ? 'jackpot_refund' : 'jackpot_entry';
    case 'jackpot_prize':
      return 'jackpot_prize';
    case 'deposit':
      return 'deposit';
    case 'withdrawal':
      return tx.idempotencyKey.endsWith(':paid') ? 'withdrawal_paid' : 'withdrawal_hold';
    case 'withdrawal_reversal':
      return 'withdrawal_returned';
    case 'agent_topup':
      return 'agent_topup';
    case 'agent_take_back':
      return 'agent_take_back';
    case 'bonus':
      return 'bonus';
    case 'adjustment':
      return 'adjustment';
    default:
      return 'other';
  }
}

/**
 * Σ of the entries of one category and channel on one account kind (and provider, for
 * house_psp_clearing), and how many transactions have such an entry. `type` is set for the
 * category `other` only (which ledger type it was).
 */
export interface ReportTotal {
  category: ReportCategory;
  channel: ReportChannel;
  kind: string;
  provider: string | null;
  type: string | null;
  amount: Santim;
  transactions: number;
}

const keyOf = (t: ReportTotal) =>
  [t.category, t.channel, t.kind, t.provider ?? '', t.type ?? ''].join('\u0000');

/** The rows in a canonical order (category, channel, kind, provider, type). */
export function sortReportTotals(totals: readonly ReportTotal[]): ReportTotal[] {
  return [...totals].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

/** Merges rows of the same key (summing amounts and transactions); zero rows are dropped. */
export function addReportTotals(...lists: ReadonlyArray<readonly ReportTotal[]>): ReportTotal[] {
  const merged = new Map<string, ReportTotal>();
  for (const list of lists) {
    for (const row of list) {
      const key = keyOf(row);
      const current = merged.get(key);
      if (current === undefined) merged.set(key, { ...row });
      else {
        current.amount += row.amount;
        current.transactions += row.transactions;
      }
    }
  }
  return sortReportTotals(
    [...merged.values()].filter((row) => row.amount !== 0n || row.transactions !== 0),
  );
}

export interface ChannelFigures {
  /** Bets accepted: stake postings less live bets rejected (online) and tickets cancelled (shop). */
  bets: number;
  /** Stakes accepted, net of those rejections and cancellations. */
  stakes: Santim;
  /** Paid on won bets before tax (the stake back and the winnings), net of corrections. */
  wonPayouts: Santim;
  cashOuts: Santim;
  /** Stakes given back for void bets, net of corrections. */
  refunds: Santim;
  /** wonPayouts + cashOuts + refunds. */
  payouts: Santim;
  /** stakes − payouts. */
  ggr: Santim;
  /** Winnings tax withheld on those payouts. */
  taxWithheld: Santim;
}

export interface ProviderFigure {
  provider: string;
  amount: Santim;
  count: number;
}

export interface ReportFigures {
  online: ChannelFigures;
  shop: ChannelFigures & {
    /** Winning tickets paid in cash at a counter. */
    ticketsPaid: Santim;
    ticketsPaidCount: number;
    /** Winnings not collected within the expiry days: back to the house. */
    unclaimed: Santim;
    unclaimedCount: number;
    agentTopups: Santim;
    agentTopupCount: number;
    agentTakeBacks: Santim;
    agentTakeBackCount: number;
  };
  jackpot: {
    entries: number;
    stakes: Santim;
    refunds: Santim;
    /** Prizes before tax. */
    prizes: Santim;
    /** stakes − refunds − prizes. */
    result: Santim;
    taxWithheld: Santim;
  };
  /** online.ggr + shop.ggr + jackpot.result. */
  totalGgr: Santim;
  /** online + shop + jackpot. */
  taxWithheld: Santim;
  deposits: { total: Santim; count: number; byProvider: ProviderFigure[] };
  withdrawals: {
    /** Asked for (the money held from the player's balance). */
    requested: Santim;
    requestedCount: number;
    /** Paid out through a provider (or a counter). */
    paid: Santim;
    paidCount: number;
    /** Given back to the player (refused, failed or not collected). */
    returned: Santim;
    returnedCount: number;
    paidByProvider: ProviderFigure[];
  };
  /** Promotion costs. */
  bonuses: Santim;
}

const BETTING_KINDS_HOUSE = new Set(['house_stakes', 'house_revenue']);

function sumOf(
  totals: readonly ReportTotal[],
  match: (row: ReportTotal) => boolean,
): { amount: Santim; transactions: number } {
  let amount = 0n;
  let transactions = 0;
  for (const row of totals) {
    if (match(row)) {
      amount += row.amount;
      transactions += row.transactions;
    }
  }
  return { amount, transactions };
}

function byProvider(
  totals: readonly ReportTotal[],
  category: ReportCategory,
  sign: 1n | -1n,
): ProviderFigure[] {
  const map = new Map<string, ProviderFigure>();
  for (const row of totals) {
    if (row.category !== category || row.kind !== 'house_psp_clearing') continue;
    const provider = row.provider ?? 'unknown';
    const current = map.get(provider) ?? { provider, amount: 0n, count: 0 };
    current.amount += sign * row.amount;
    current.count += row.transactions;
    map.set(provider, current);
  }
  return [...map.values()]
    .filter((p) => p.amount !== 0n || p.count !== 0)
    .sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
}

function channelFigures(totals: readonly ReportTotal[], channel: ReportChannel): ChannelFigures {
  const of = (category: ReportCategory, kind?: (k: string) => boolean) =>
    sumOf(
      totals,
      (r) =>
        r.channel === channel && r.category === category && (kind === undefined || kind(r.kind)),
    );
  const isStakes = (k: string) => k === 'house_stakes';
  const isHouse = (k: string) => BETTING_KINDS_HOUSE.has(k);
  const isTax = (k: string) => k === 'house_tax_payable';
  const posted = of('bet_stake', isStakes);
  const rejected = of('bet_rejection', isStakes);
  const cancelled = of('shop_ticket_cancelled', isStakes);
  // What the house gave back = −(house_stakes + house_revenue) of the settlement postings: a won
  // bet's stake and winnings (before tax), a cash-out's amount, a void bet's stake; a lost bet 0.
  const wonPayouts = -of('bet_settlement', isHouse).amount;
  const refunds = -of('bet_void', isHouse).amount;
  const cashOuts = -of('bet_cashout', isHouse).amount;
  const stakes = posted.amount + rejected.amount + cancelled.amount;
  const payouts = wonPayouts + refunds + cashOuts;
  return {
    bets: posted.transactions - rejected.transactions - cancelled.transactions,
    stakes,
    wonPayouts,
    cashOuts,
    refunds,
    payouts,
    ggr: stakes - payouts,
    taxWithheld:
      of('bet_settlement', isTax).amount +
      of('bet_void', isTax).amount +
      of('bet_cashout', isTax).amount,
  };
}

/** The report's figures from its totals (see the module comment and REPORT_CATEGORIES). */
export function summarizeReport(totals: readonly ReportTotal[]): ReportFigures {
  const any = (category: ReportCategory, kind: string) =>
    sumOf(totals, (r) => r.category === category && r.kind === kind);
  const online = channelFigures(totals, 'online');
  const shopBetting = channelFigures(totals, 'shop');
  const paid = any('shop_ticket_paid', 'house_retail_payable');
  const expired = any('shop_ticket_expired', 'house_retail_payable');
  const topups = any('agent_topup', 'agent_balance');
  const takeBacks = any('agent_take_back', 'agent_balance');
  const jackpotEntries = any('jackpot_entry', 'house_jackpot');
  const jackpotRefunds = any('jackpot_refund', 'house_jackpot');
  const jackpotPrizes = any('jackpot_prize', 'house_jackpot');
  const jackpotTax = any('jackpot_prize', 'house_tax_payable');
  const jackpotResult = jackpotEntries.amount + jackpotRefunds.amount + jackpotPrizes.amount;
  const depositsByProvider = byProvider(totals, 'deposit', -1n);
  const paidByProvider = byProvider(totals, 'withdrawal_paid', 1n);
  const holds = any('withdrawal_hold', 'house_withdrawals_pending');
  const returned = any('withdrawal_returned', 'player_cash');
  const jackpot = {
    entries: jackpotEntries.transactions - jackpotRefunds.transactions,
    stakes: jackpotEntries.amount,
    refunds: -jackpotRefunds.amount,
    prizes: -jackpotPrizes.amount,
    result: jackpotResult,
    taxWithheld: jackpotTax.amount,
  };
  return {
    online,
    shop: {
      ...shopBetting,
      ticketsPaid: -paid.amount,
      ticketsPaidCount: paid.transactions,
      unclaimed: -expired.amount,
      unclaimedCount: expired.transactions,
      agentTopups: topups.amount,
      agentTopupCount: topups.transactions,
      agentTakeBacks: -takeBacks.amount,
      agentTakeBackCount: takeBacks.transactions,
    },
    jackpot,
    totalGgr: online.ggr + shopBetting.ggr + jackpot.result,
    taxWithheld: online.taxWithheld + shopBetting.taxWithheld + jackpot.taxWithheld,
    deposits: {
      total: depositsByProvider.reduce((s, p) => s + p.amount, 0n),
      count: depositsByProvider.reduce((s, p) => s + p.count, 0),
      byProvider: depositsByProvider,
    },
    withdrawals: {
      requested: holds.amount,
      requestedCount: holds.transactions,
      paid: paidByProvider.reduce((s, p) => s + p.amount, 0n),
      paidCount: paidByProvider.reduce((s, p) => s + p.count, 0),
      returned: returned.amount,
      returnedCount: returned.transactions,
      paidByProvider,
    },
    bonuses: -any('bonus', 'house_promotions').amount,
  };
}

/** One ledger transaction with its entries (the input of `reportTotalsOfPostings`). */
export interface ReportPosting {
  type: string;
  idempotencyKey: string;
  reversedType?: string | null;
  channel: ReportChannel;
  entries: ReadonlyArray<{ kind: string; provider?: string | null; amount: Santim }>;
}

/**
 * Groups postings the way the database query does (the reference implementation): Σ amount per
 * (category, channel, kind, provider, type) and the number of transactions with such an entry.
 */
export function reportTotalsOfPostings(postings: readonly ReportPosting[]): ReportTotal[] {
  const rows: ReportTotal[] = [];
  for (const posting of postings) {
    const category = classifyReportPosting(posting);
    const type = category === 'other' ? posting.type : null;
    const perKind = new Map<string, { kind: string; provider: string | null; amount: Santim }>();
    for (const entry of posting.entries) {
      const provider = entry.provider ?? null;
      const key = balanceKey(entry.kind, provider);
      const current = perKind.get(key) ?? { kind: entry.kind, provider, amount: 0n };
      current.amount += entry.amount;
      perKind.set(key, current);
    }
    for (const line of perKind.values()) {
      rows.push({ category, channel: posting.channel, type, transactions: 1, ...line });
    }
  }
  return addReportTotals(rows);
}

/** Σ of every row: 0 when the postings balance (each one sums to zero). */
export function reportImbalance(totals: readonly ReportTotal[]): Santim {
  return totals.reduce((s, row) => s + row.amount, 0n);
}

/** Σ of the rows per account kind (and provider): how much each kind moved in the period. */
export function movementsByKind(totals: readonly ReportTotal[]): Map<string, Santim> {
  const moved = new Map<string, Santim>();
  for (const row of totals) {
    const key = balanceKey(row.kind, row.provider);
    moved.set(key, (moved.get(key) ?? 0n) + row.amount);
  }
  return moved;
}

/** The key of a balance line: the kind, and the provider for house_psp_clearing. */
export function balanceKey(kind: string, provider: string | null): string {
  return provider === null ? kind : `${kind}:${provider}`;
}

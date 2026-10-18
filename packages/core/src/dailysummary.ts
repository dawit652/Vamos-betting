import { BPS_DENOMINATOR, type Santim } from './money';

/**
 * The regulator's daily summary, computed from ledger postings (pure part).
 *
 * The database groups the postings of a business day (by
 * ledger_transactions.created_at, so a result correction lands on the day
 * it is posted and earlier days keep what was paid then, as on the
 * back-office dashboard) into PostingCategory x ledger account kind totals;
 * `summarizeDailyTotals` turns them into the figures below. Every amount is
 * santim; payouts are gross (before the winnings tax).
 *
 * - turnover = stakes accepted: bet stakes (`bet_stake`, net of the live
 *   bets rejected after the delay, whose stake went straight back) plus
 *   jackpot entry costs;
 * - payouts = what went back to players from betting, before tax: won bets
 *   (stake returned + winnings + bonus), cash-outs, refunds (void bets and
 *   entries of void jackpot rounds) and jackpot prizes; a correction's
 *   reversal counts negative on the day it is posted;
 * - GGR = turnover - payouts (equivalently: what players lost to the house
 *   that day, net of the tax withheld for the authority);
 * - tax withheld = what the betting postings credited to house_tax_payable;
 * - bonuses = promotion costs (`bonus` postings out of house_promotions);
 * - deposits / withdrawals = money in from / out to payment providers
 *   (house_psp_clearing movements of `deposit` / paid `withdrawal` postings);
 * - ELS commission due = floor(GGR x rate / 10000), 0 when GGR <= 0.
 *
 * This is a stakes-in, payouts-out ("cash") view of the day: a stake counts
 * on the day it is accepted, its payout on the day it is paid. The
 * dashboard's GGR (what house_revenue gained, i.e. settled stakes - payouts)
 * differs from it by the change in open stakes; the two agree over any
 * period in which every bet placed was also settled.
 */

/**
 * Default ELS commission rate (setting `els_commission`): 15% of a day's
 * positive GGR. A placeholder to confirm with counsel and the ELS.
 */
export const DEFAULT_ELS_COMMISSION_RATE_BPS = 1_500;

/** Idempotency-key prefix of the refund of a live bet rejected after its delay (not a settlement). */
export const REJECTION_KEY_PREFIX = 'reject:';
/** Idempotency-key prefix of the refund of a jackpot entry of a void round. */
export const JACKPOT_REFUND_KEY_PREFIX = 'jackpot_refund:';

export const POSTING_CATEGORIES = [
  /** `bet_stake`: player_cash -stake, house_stakes +stake. */
  'bet_stake',
  /** `bet_refund` of a live bet rejected after the delay. */
  'bet_rejection',
  /** `bet_payout` (won or lost), or the reversal of one. */
  'bet_settlement',
  /** `bet_refund` of a void bet, or the reversal of one. */
  'bet_void',
  /** `bet_cashout` (never reversed today). */
  'bet_cashout',
  /** `jackpot_entry`: player_cash -cost, house_jackpot +cost. */
  'jackpot_entry',
  /** `jackpot_entry` refund of a void round: house_jackpot -cost, player_cash +cost. */
  'jackpot_refund',
  /** `jackpot_prize`: house_jackpot -gross, player_cash +net, house_tax_payable +tax. */
  'jackpot_prize',
  'bonus',
  'deposit',
  /** `withdrawal`: the hold (no PSP entry) and the payout (house_psp_clearing +amount). */
  'withdrawal',
  /** Everything else (demo top-ups, withdrawal reversals, adjustments…): not in the summary. */
  'other',
] as const;
export type PostingCategory = (typeof POSTING_CATEGORIES)[number];

/** The categories whose postings are betting (stakes in, payouts out). */
export const BETTING_CATEGORIES: readonly PostingCategory[] = [
  'bet_stake',
  'bet_rejection',
  'bet_settlement',
  'bet_void',
  'bet_cashout',
  'jackpot_entry',
  'jackpot_refund',
  'jackpot_prize',
];

const SETTLEMENT_CATEGORIES: readonly PostingCategory[] = [
  'bet_settlement',
  'bet_void',
  'bet_cashout',
];

/**
 * The category of a ledger transaction. `reversedType` is the type of the
 * transaction a `settlement_reversal` negates (its `settle:` posting).
 */
export function classifyPosting(tx: {
  type: string;
  idempotencyKey: string;
  reversedType?: string | null;
}): PostingCategory {
  switch (tx.type) {
    case 'bet_stake':
      return 'bet_stake';
    case 'bet_refund':
      return tx.idempotencyKey.startsWith(REJECTION_KEY_PREFIX) ? 'bet_rejection' : 'bet_void';
    case 'bet_payout':
      return 'bet_settlement';
    case 'bet_cashout':
      return 'bet_cashout';
    case 'settlement_reversal':
      if (tx.reversedType === 'bet_refund') return 'bet_void';
      if (tx.reversedType === 'bet_cashout') return 'bet_cashout';
      return 'bet_settlement';
    case 'jackpot_entry':
      return tx.idempotencyKey.startsWith(JACKPOT_REFUND_KEY_PREFIX)
        ? 'jackpot_refund'
        : 'jackpot_entry';
    case 'jackpot_prize':
      return 'jackpot_prize';
    case 'bonus':
      return 'bonus';
    case 'deposit':
      return 'deposit';
    case 'withdrawal':
      return 'withdrawal';
    default:
      return 'other';
  }
}

/**
 * Σ of the entries of one category on one account kind, and how many
 * transactions of that category have an entry on that kind.
 */
export interface CategoryTotal {
  category: PostingCategory;
  /** A ledger account kind (player_cash, house_stakes, …). */
  kind: string;
  amount: Santim;
  transactions: number;
}

/** One ledger transaction with its entries (the input of `totalsOfPostings`). */
export interface SummaryPosting {
  type: string;
  idempotencyKey: string;
  reversedType?: string | null;
  entries: ReadonlyArray<{ kind: string; amount: Santim }>;
}

/**
 * Groups postings the way the database query does (reference
 * implementation): Σ amount per (category, kind) and the number of
 * transactions with an entry on that kind.
 */
export function totalsOfPostings(postings: readonly SummaryPosting[]): CategoryTotal[] {
  const totals = new Map<string, CategoryTotal>();
  for (const posting of postings) {
    const category = classifyPosting(posting);
    const kinds = new Map<string, Santim>();
    for (const entry of posting.entries) {
      kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0n) + entry.amount);
    }
    for (const [kind, amount] of kinds) {
      const key = `${category}\u0000${kind}`;
      const current = totals.get(key);
      if (current) {
        current.amount += amount;
        current.transactions += 1;
      } else {
        totals.set(key, { category, kind, amount, transactions: 1 });
      }
    }
  }
  return [...totals.values()];
}

export interface DailyFigures {
  /** Stakes accepted: betStakes + jackpotStakes. */
  turnover: Santim;
  /** Bet stakes, net of live bets rejected after the delay. */
  betStakes: Santim;
  /** Bets accepted (stakes posted minus rejections). */
  betCount: number;
  /** Jackpot entry costs. */
  jackpotStakes: Santim;
  jackpotEntryCount: number;
  /** Gross payouts: wonPayouts + cashOuts + refunds + jackpotPrizes. */
  payouts: Santim;
  /** Paid on won bets, before tax (stake returned + winnings + bonus), net of reversals. */
  wonPayouts: Santim;
  /** Cash-outs paid, before tax. */
  cashOuts: Santim;
  /** Stakes given back: void bets and entries of void jackpot rounds, net of reversals. */
  refunds: Santim;
  /** Jackpot prizes, before tax. */
  jackpotPrizes: Santim;
  /** turnover - payouts. */
  ggr: Santim;
  /** Credited to house_tax_payable by betting postings (net of reversals). */
  taxWithheld: Santim;
  /** Promotion costs (`bonus` postings). */
  bonuses: Santim;
  deposits: Santim;
  depositCount: number;
  /** Withdrawals paid out through a provider. */
  withdrawals: Santim;
  withdrawalCount: number;
  /** Players with a stake (bet or jackpot entry) posted that day. */
  activePlayers: number;
  /** The ELS commission rate used (basis points of GGR). */
  commissionRateBps: number;
  /** floor(ggr x commissionRateBps / 10000), 0 when ggr <= 0. */
  commissionDue: Santim;
}

/** The figures of DailyFigures that are amounts (santim). */
export const DAILY_FIGURE_AMOUNTS = [
  'turnover',
  'betStakes',
  'jackpotStakes',
  'payouts',
  'wonPayouts',
  'cashOuts',
  'refunds',
  'jackpotPrizes',
  'ggr',
  'taxWithheld',
  'bonuses',
  'deposits',
  'withdrawals',
  'commissionDue',
] as const satisfies ReadonlyArray<keyof DailyFigures>;

/** The figures of DailyFigures that are counts or rates. */
export const DAILY_FIGURE_NUMBERS = [
  'betCount',
  'jackpotEntryCount',
  'depositCount',
  'withdrawalCount',
  'activePlayers',
  'commissionRateBps',
] as const satisfies ReadonlyArray<keyof DailyFigures>;

function assertRateBps(rateBps: number): bigint {
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new RangeError(`commission rate must be an integer from 0 to 10000 bps (got ${rateBps})`);
  }
  return BigInt(rateBps);
}

/** ELS commission on a day's GGR: floor(ggr x rateBps / 10000); 0 when ggr <= 0. */
export function elsCommissionDue(ggr: Santim, rateBps: number): Santim {
  const rate = assertRateBps(rateBps);
  if (typeof ggr !== 'bigint') throw new TypeError('ggr must be bigint santim');
  return ggr > 0n ? (ggr * rate) / BPS_DENOMINATOR : 0n;
}

/** The daily figures from category totals (see the module comment for the definitions). */
export function summarizeDailyTotals(
  totals: readonly CategoryTotal[],
  input: { activePlayers: number; commissionRateBps: number },
): DailyFigures {
  if (!Number.isSafeInteger(input.activePlayers) || input.activePlayers < 0) {
    throw new RangeError('activePlayers must be a non-negative integer');
  }
  const amounts = new Map<string, Santim>();
  const counts = new Map<string, number>();
  for (const total of totals) {
    if (typeof total.amount !== 'bigint') throw new TypeError('amounts must be bigint santim');
    if (!Number.isSafeInteger(total.transactions) || total.transactions < 0) {
      throw new RangeError('transaction counts must be non-negative integers');
    }
    const key = `${total.category}\u0000${total.kind}`;
    amounts.set(key, (amounts.get(key) ?? 0n) + total.amount);
    counts.set(key, (counts.get(key) ?? 0) + total.transactions);
  }
  const amt = (category: PostingCategory, kind: string) =>
    amounts.get(`${category}\u0000${kind}`) ?? 0n;
  const txs = (category: PostingCategory, kind: string) =>
    counts.get(`${category}\u0000${kind}`) ?? 0;
  /** What a settlement category paid out, before tax: the stake released minus what the house kept. */
  const gross = (category: PostingCategory) =>
    -(amt(category, 'house_stakes') + amt(category, 'house_revenue'));

  const betStakes = amt('bet_stake', 'house_stakes') + amt('bet_rejection', 'house_stakes');
  const jackpotStakes = amt('jackpot_entry', 'house_jackpot');
  const turnover = betStakes + jackpotStakes;
  const wonPayouts = gross('bet_settlement');
  const cashOuts = gross('bet_cashout');
  const refunds = gross('bet_void') - amt('jackpot_refund', 'house_jackpot');
  const jackpotPrizes = -amt('jackpot_prize', 'house_jackpot');
  const payouts = wonPayouts + cashOuts + refunds + jackpotPrizes;
  const ggr = turnover - payouts;
  let taxWithheld = 0n;
  for (const category of BETTING_CATEGORIES) taxWithheld += amt(category, 'house_tax_payable');

  return {
    turnover,
    betStakes,
    betCount: txs('bet_stake', 'house_stakes') - txs('bet_rejection', 'house_stakes'),
    jackpotStakes,
    jackpotEntryCount: txs('jackpot_entry', 'house_jackpot'),
    payouts,
    wonPayouts,
    cashOuts,
    refunds,
    jackpotPrizes,
    ggr,
    taxWithheld,
    bonuses: -amt('bonus', 'house_promotions'),
    deposits: -amt('deposit', 'house_psp_clearing'),
    depositCount: txs('deposit', 'house_psp_clearing'),
    withdrawals: amt('withdrawal', 'house_psp_clearing'),
    withdrawalCount: txs('withdrawal', 'house_psp_clearing'),
    activePlayers: input.activePlayers,
    commissionRateBps: input.commissionRateBps,
    commissionDue: elsCommissionDue(ggr, input.commissionRateBps),
  };
}

/** True for the categories that settle a bet (won/lost, void, cash-out). */
export function isSettlementCategory(category: PostingCategory): boolean {
  return SETTLEMENT_CATEGORIES.includes(category);
}

/** The names of the figures that differ between two summaries ([] when equal). */
export function diffDailyFigures(a: DailyFigures, b: DailyFigures): string[] {
  const fields: Array<keyof DailyFigures> = [...DAILY_FIGURE_AMOUNTS, ...DAILY_FIGURE_NUMBERS];
  return fields.filter((field) => a[field] !== b[field]);
}

// ---------------------------------------------------------------------------
// CSV (the ELS file reporter's daily summaries and the back office download).

/** One daily summary as a CSV row. */
export interface DailySummaryRow extends DailyFigures {
  businessDate: string;
  status: string;
  version: number;
  windowStart: Date;
  windowEnd: Date;
  /** SHA-256 of the figures (daily_summaries.hash). */
  hash: string | null;
}

/** CSV columns, in order (amounts in santim: 1 ETB = 100 santim). */
export const DAILY_SUMMARY_CSV_COLUMNS = [
  ['business_date', 'businessDate'],
  ['status', 'status'],
  ['version', 'version'],
  ['window_start', 'windowStart'],
  ['window_end', 'windowEnd'],
  ['turnover', 'turnover'],
  ['bet_stakes', 'betStakes'],
  ['bet_count', 'betCount'],
  ['jackpot_stakes', 'jackpotStakes'],
  ['jackpot_entry_count', 'jackpotEntryCount'],
  ['payouts', 'payouts'],
  ['won_payouts', 'wonPayouts'],
  ['cash_outs', 'cashOuts'],
  ['refunds', 'refunds'],
  ['jackpot_prizes', 'jackpotPrizes'],
  ['ggr', 'ggr'],
  ['tax_withheld', 'taxWithheld'],
  ['bonuses', 'bonuses'],
  ['deposits', 'deposits'],
  ['deposit_count', 'depositCount'],
  ['withdrawals', 'withdrawals'],
  ['withdrawal_count', 'withdrawalCount'],
  ['active_players', 'activePlayers'],
  ['commission_rate_bps', 'commissionRateBps'],
  ['commission_due', 'commissionDue'],
  ['hash', 'hash'],
] as const satisfies ReadonlyArray<readonly [string, keyof DailySummaryRow]>;

/** One CSV field (RFC 4180): quoted when it holds a comma, quote or line break. */
export function csvField(value: string | number | bigint | boolean | Date | null): string {
  if (value === null) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Daily summaries as CSV text: a header line, then one line per summary (CRLF line ends). */
export function dailySummaryCsv(rows: readonly DailySummaryRow[]): string {
  const lines = [DAILY_SUMMARY_CSV_COLUMNS.map(([column]) => column).join(',')];
  for (const row of rows) {
    lines.push(DAILY_SUMMARY_CSV_COLUMNS.map(([, field]) => csvField(row[field])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

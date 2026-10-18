import { and, gte, inArray, isNotNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { domainUnprocessable } from '../errors';
import type { DbExecutor } from '../ledger/types';
import { OPEN_PAYOUT_STATUSES } from '../payments/types';
import { users } from '../schema/accounts';
import { rejectionLedgerKey } from '../betting/postings';
import { bets } from '../schema/betting';
import { jackpotEntries } from '../schema/jackpots';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';
import { paymentIntents, payouts } from '../schema/payments';

/** Ledger transaction types that settle a bet or reverse a settlement. */
const BET_SETTLEMENT_TYPES = ['bet_payout', 'bet_refund', 'bet_cashout', 'settlement_reversal'];
/** Idempotency-key prefix of the refund of a bet rejected after the live delay (not a settlement). */
const REJECTION_KEY_PREFIX = rejectionLedgerKey('');

/**
 * The back-office dashboard (dashboard.view): betting and jackpot activity,
 * payments and players over a time window [from, to), and what is at stake
 * now. Every figure is a plain sum over the business rows (santim), so it
 * can be checked by hand:
 *
 * - turnover: Σ stake of the bets placed in the window, except rejected
 *   ones (their stake went back);
 * - settled bets: the bet settlement postings (won, lost, void, cashed
 *   out) made in the window, by ledger time, net of the reversals made in
 *   it (a result correction reverses the old settlement and posts the new
 *   one when it happens, so earlier windows keep what was paid then):
 *   settled = Σ stakes released from house_stakes; GGR = what the
 *   house_revenue account gained; payouts = settled − GGR (winnings and
 *   refunds before tax, cash-outs); the winnings tax withheld is shown
 *   apart (it belongs to the tax authority). A window holding a
 *   correction can show negative payouts, tax or count;
 * - jackpots: entries placed in the window; entries settled in the
 *   window: GGR = Σ cost − Σ gross prizes − Σ refunds;
 * - open liabilities (now, not windowed): the open and pending bets, their
 *   stakes (the house_stakes balance) and potential payouts (gross, what
 *   the house pays if every leg wins);
 * - payments: deposits that succeeded and withdrawals paid in the window
 *   (by completion time); open withdrawals, the review queue and the
 *   flagged payments now.
 */

export interface DashboardAmount {
  count: number;
  /** Santim. */
  amount: bigint;
}

export interface Dashboard {
  from: Date;
  to: Date;
  betting: {
    /** Bets placed in the window, rejected ones excepted. */
    placed: DashboardAmount;
    /** Σ their stakes (= placed.amount). */
    turnover: bigint;
    /**
     * Bet settlements posted in the window (won, lost, void, cashed out) and
     * their stakes, net of the settlements reversed in it by corrections.
     */
    settled: DashboardAmount;
    /** Gross payouts posted in the window (winnings and refunds before tax, cash-outs), net of reversals. */
    payouts: bigint;
    /** Winnings tax withheld in the window, net of reversals. */
    taxWithheld: bigint;
    /** Gross gaming revenue: what house_revenue gained from bets in the window (settled.amount − payouts). */
    ggr: bigint;
  };
  jackpots: {
    /** Entries placed in the window and their cost. */
    entries: DashboardAmount;
    /** Entries settled in the window and their cost. */
    settled: DashboardAmount;
    /** Σ gross prizes of those entries. */
    prizes: bigint;
    /** Σ cost of those refunded (void). */
    refunds: bigint;
    /** settled.amount − prizes − refunds. */
    ggr: bigint;
  };
  /** Now: the open and pending bets. */
  openLiabilities: {
    bets: number;
    stakes: bigint;
    /** Σ potential gross payouts. */
    potentialPayout: bigint;
    /** Σ potential net payouts (after the winnings tax). */
    potentialNetPayout: bigint;
  };
  payments: {
    /** Deposits that succeeded in the window. */
    deposits: DashboardAmount;
    /** Withdrawals paid in the window. */
    withdrawals: DashboardAmount;
    /** Now: withdrawals requested, approved or being processed (their holds). */
    openWithdrawals: DashboardAmount;
    /** Now: withdrawals waiting for staff review (`requested`). */
    awaitingReview: number;
    /** Now: flagged withdrawals and deposits waiting for staff. */
    flaggedWithdrawals: number;
    flaggedDeposits: number;
  };
  players: {
    /** Accounts registered in the window. */
    registered: number;
    /** Players who placed a bet in the window. */
    active: number;
  };
}

/** Longest window the dashboard sums over (a year and a day). */
export const DASHBOARD_MAX_WINDOW_MS = 366 * 24 * 3_600_000;

const amountOf = (row: { count: number; amount: string } | undefined): DashboardAmount => ({
  count: row?.count ?? 0,
  amount: BigInt(row?.amount ?? '0'),
});

/** The dashboard for [from, to). 422 `invalid_range` unless from < to within a year. */
export async function getDashboard(
  exec: DbExecutor,
  input: { from: Date; to: Date },
): Promise<Dashboard> {
  const { from, to } = input;
  const span = to.getTime() - from.getTime();
  if (!(span > 0) || span > DASHBOARD_MAX_WINDOW_MS) {
    throw domainUnprocessable(
      'invalid_range',
      'The dashboard window must start before it ends and span at most a year.',
    );
  }
  const within = (column: Parameters<typeof gte>[0]): SQL =>
    and(gte(column, from), lt(column, to))!;

  const [placed] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`COALESCE(sum(${bets.stake}), 0)::text`,
    })
    .from(bets)
    .where(and(within(bets.placedAt), ne(bets.status, 'rejected')));
  // Bet settlements by the time they were posted to the ledger (refType 'bet'): a payout
  // stays in the window it was paid in, and a later correction (its reversal and the new
  // settlement) lands in the window of the correction. Rejected bets' refunds are no
  // settlement (their stake is not turnover either).
  const settlementTypes = sql.join(
    BET_SETTLEMENT_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );
  const settledResult = await exec.execute<{
    count: number;
    stakes: string;
    revenue: string;
    tax: string;
  }>(sql`
    WITH postings AS (
      SELECT t.id, t.type FROM ${ledgerTransactions} t
      WHERE t.ref_type = 'bet'
        AND t.type::text IN (${settlementTypes})
        AND t.idempotency_key NOT LIKE ${`${REJECTION_KEY_PREFIX}%`}
        AND t.created_at >= ${from.toISOString()}::timestamptz
        AND t.created_at < ${to.toISOString()}::timestamptz
    )
    SELECT
      ((SELECT count(*) FROM postings WHERE type <> 'settlement_reversal')
        - (SELECT count(*) FROM postings WHERE type = 'settlement_reversal'))::int AS count,
      COALESCE(sum(-e.amount) FILTER (WHERE a.kind = 'house_stakes'), 0)::text AS stakes,
      COALESCE(sum(e.amount) FILTER (WHERE a.kind = 'house_revenue'), 0)::text AS revenue,
      COALESCE(sum(e.amount) FILTER (WHERE a.kind = 'house_tax_payable'), 0)::text AS tax
    FROM postings p
    JOIN ${ledgerEntries} e ON e.transaction_id = p.id
    JOIN ${ledgerAccounts} a ON a.id = e.account_id
  `);
  const settled = settledResult.rows[0];
  const [entries] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`COALESCE(sum(${jackpotEntries.cost}), 0)::text`,
    })
    .from(jackpotEntries)
    .where(within(jackpotEntries.placedAt));
  const [entriesSettled] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`COALESCE(sum(${jackpotEntries.cost}), 0)::text`,
      prizes: sql<string>`COALESCE(sum(${jackpotEntries.prizeGross}) FILTER (WHERE ${jackpotEntries.status} = 'won'), 0)::text`,
      refunds: sql<string>`COALESCE(sum(${jackpotEntries.cost}) FILTER (WHERE ${jackpotEntries.status} = 'void'), 0)::text`,
    })
    .from(jackpotEntries)
    .where(
      and(
        inArray(jackpotEntries.status, ['won', 'lost', 'void']),
        isNotNull(jackpotEntries.settledAt),
        within(jackpotEntries.settledAt),
      ),
    );
  const [open] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      stakes: sql<string>`COALESCE(sum(${bets.stake}), 0)::text`,
      potential: sql<string>`COALESCE(sum(${bets.potentialGrossPayout}), 0)::text`,
      potentialNet: sql<string>`COALESCE(sum(${bets.potentialNetPayout}), 0)::text`,
    })
    .from(bets)
    .where(inArray(bets.status, ['open', 'pending_acceptance']));
  const [deposits] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`COALESCE(sum(${paymentIntents.amount}), 0)::text`,
    })
    .from(paymentIntents)
    .where(
      and(
        sql`${paymentIntents.status} = 'succeeded'`,
        isNotNull(paymentIntents.completedAt),
        within(paymentIntents.completedAt),
      ),
    );
  const [paid] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`COALESCE(sum(${payouts.amount}), 0)::text`,
    })
    .from(payouts)
    .where(
      and(
        sql`${payouts.status} = 'paid'`,
        isNotNull(payouts.completedAt),
        within(payouts.completedAt),
      ),
    );
  const [openPayouts] = await exec
    .select({
      count: sql<number>`count(*)::int`,
      amount: sql<string>`COALESCE(sum(${payouts.amount}), 0)::text`,
      review: sql<number>`count(*) FILTER (WHERE ${payouts.status} = 'requested')::int`,
    })
    .from(payouts)
    .where(inArray(payouts.status, [...OPEN_PAYOUT_STATUSES]));
  const [flagged] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(payouts)
    .where(isNotNull(payouts.flaggedAt));
  const [flaggedDeposits] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(paymentIntents)
    .where(isNotNull(paymentIntents.flaggedAt));
  const [registered] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(within(users.createdAt));
  // Players with a bet or a jackpot entry in the window.
  const [active] = await exec.select({ count: sql<number>`count(*)::int` }).from(
    sql`(SELECT ${bets.userId} AS user_id FROM ${bets} WHERE ${within(bets.placedAt)}
           UNION
           SELECT ${jackpotEntries.userId} FROM ${jackpotEntries}
           WHERE ${within(jackpotEntries.placedAt)}) AS players`,
  );

  const settledStakes = BigInt(settled?.stakes ?? '0');
  const ggr = BigInt(settled?.revenue ?? '0');
  const jackpotSettled = amountOf(entriesSettled);
  const prizes = BigInt(entriesSettled?.prizes ?? '0');
  const refunds = BigInt(entriesSettled?.refunds ?? '0');
  const placedAmount = amountOf(placed);
  return {
    from,
    to,
    betting: {
      placed: placedAmount,
      turnover: placedAmount.amount,
      settled: { count: Number(settled?.count ?? 0), amount: settledStakes },
      // stake − revenue: the gross payout of a won bet, the refund of a void one, a cash-out.
      payouts: settledStakes - ggr,
      taxWithheld: BigInt(settled?.tax ?? '0'),
      ggr,
    },
    jackpots: {
      entries: amountOf(entries),
      settled: jackpotSettled,
      prizes,
      refunds,
      ggr: jackpotSettled.amount - prizes - refunds,
    },
    openLiabilities: {
      bets: open?.count ?? 0,
      stakes: BigInt(open?.stakes ?? '0'),
      potentialPayout: BigInt(open?.potential ?? '0'),
      potentialNetPayout: BigInt(open?.potentialNet ?? '0'),
    },
    payments: {
      deposits: amountOf(deposits),
      withdrawals: amountOf(paid),
      openWithdrawals: amountOf(openPayouts),
      awaitingReview: openPayouts?.review ?? 0,
      flaggedWithdrawals: flagged?.count ?? 0,
      flaggedDeposits: flaggedDeposits?.count ?? 0,
    },
    players: {
      registered: registered?.count ?? 0,
      active: active?.count ?? 0,
    },
  };
}

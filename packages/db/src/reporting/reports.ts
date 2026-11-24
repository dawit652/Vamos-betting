import { createHash } from 'node:crypto';
import {
  addBusinessDays,
  addReportTotals,
  balanceKey,
  businessDateOf,
  businessDayWindow,
  movementsByKind,
  reportImbalance,
  reportWindow,
  sortReportTotals,
  summarizeReport,
  type ReportCategory,
  type ReportChannel,
  type ReportFigures,
  type ReportPeriod,
  type ReportTotal,
  type ReportWindow,
} from '@vamos/core';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { DbExecutor } from '../ledger/types';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';
import { retailTickets } from '../schema/retail-tickets';
import {
  reportDays,
  type ReportDay,
  type StoredReportChecks,
  type StoredReportTotal,
} from '../schema/reports';

/**
 * Owner reports for a day, a week, a month and a year (owner, 22 Nov 2026: "never make a mistake";
 * docs/plans/owner-reports.md). The figures are always recomputed from the double-entry ledger
 * (core `summarizeReport` over the period's postings, grouped by Ethiopian business day), and
 * every report checks itself:
 *
 * 1. the period's postings sum to zero, and no single posting is unbalanced;
 * 2. each closed day still matches what it was when it was closed (`report_days`, written once
 *    after midnight and never changed): a back-dated or edited posting shows as "changed";
 * 3. opening balances + the period's movements = closing balances, the closing side taken
 *    independently (the day's close, or the accounts' stored balances for a period still open);
 * 4. every closed day passed its own checks when it was closed.
 *
 * A week, a month and a year are the sum of their days by construction (core, property-tested).
 */

/** The SQL twin of core `classifyReportPosting` (a test compares the two on real postings). */
const CATEGORY_SQL = sql`
  CASE t.type
    WHEN 'bet_stake' THEN 'bet_stake'
    WHEN 'bet_refund' THEN CASE WHEN starts_with(t.idempotency_key, 'reject:') THEN 'bet_rejection' ELSE 'bet_void' END
    WHEN 'bet_payout' THEN 'bet_settlement'
    WHEN 'bet_cashout' THEN 'bet_cashout'
    WHEN 'settlement_reversal' THEN
      CASE r.type WHEN 'bet_refund' THEN 'bet_void' WHEN 'bet_cashout' THEN 'bet_cashout' ELSE 'bet_settlement' END
    WHEN 'retail_ticket_cancel' THEN 'shop_ticket_cancelled'
    WHEN 'retail_ticket_payout' THEN 'shop_ticket_paid'
    WHEN 'retail_ticket_expiry' THEN 'shop_ticket_expired'
    WHEN 'jackpot_entry' THEN CASE WHEN starts_with(t.idempotency_key, 'jackpot_refund:') THEN 'jackpot_refund' ELSE 'jackpot_entry' END
    WHEN 'jackpot_prize' THEN 'jackpot_prize'
    WHEN 'deposit' THEN 'deposit'
    WHEN 'withdrawal' THEN CASE WHEN right(t.idempotency_key, 5) = ':paid' THEN 'withdrawal_paid' ELSE 'withdrawal_hold' END
    WHEN 'withdrawal_reversal' THEN 'withdrawal_returned'
    WHEN 'agent_topup' THEN 'agent_topup'
    WHEN 'agent_take_back' THEN 'agent_take_back'
    WHEN 'bonus' THEN 'bonus'
    WHEN 'adjustment' THEN 'adjustment'
    ELSE 'other'
  END`;

/** A posting of the agent shops: a shop ticket's own postings, or an agent's balance. */
const CHANNEL_SQL = sql`
  CASE WHEN t.type IN ('retail_ticket_cancel', 'retail_ticket_payout', 'retail_ticket_expiry',
                       'agent_topup', 'agent_take_back')
         OR (t.ref_type = 'bet' AND EXISTS (
               SELECT 1 FROM ${retailTickets} rt WHERE rt.bet_id::text = t.ref_id))
       THEN 'shop' ELSE 'online' END`;

/** Ethiopian business date (UTC+3, no daylight saving) of a timestamp, as YYYY-MM-DD. */
const BUSINESS_DATE_SQL = sql`((t.created_at AT TIME ZONE 'UTC') + interval '3 hours')::date::text`;

interface TotalRow {
  day: string;
  category: string;
  channel: string;
  type: string | null;
  kind: string;
  provider: string | null;
  amount: string;
  transactions: number;
  [key: string]: unknown;
}

/**
 * The ReportTotal rows of every business day in [start, end) (end null: everything visible now),
 * one map entry per day that has postings.
 */
export async function loadReportTotalsByDay(
  exec: DbExecutor,
  range: { start: Date; end: Date | null },
): Promise<Map<string, ReportTotal[]>> {
  const result = await exec.execute<TotalRow>(sql`
    WITH tx AS (
      SELECT t.id, t.type::text AS type, ${BUSINESS_DATE_SQL} AS day,
        ${CATEGORY_SQL} AS category, ${CHANNEL_SQL} AS channel
      FROM ${ledgerTransactions} t
      LEFT JOIN ${ledgerTransactions} r
        ON t.type = 'settlement_reversal' AND r.idempotency_key = 'settle:' || substr(t.idempotency_key, 9)
      WHERE t.created_at >= ${range.start.toISOString()}::timestamptz
        AND (${range.end === null ? null : range.end.toISOString()}::timestamptz IS NULL
             OR t.created_at < ${range.end === null ? null : range.end.toISOString()}::timestamptz)
    )
    SELECT tx.day, tx.category, tx.channel,
      CASE WHEN tx.category = 'other' THEN tx.type END AS type,
      a.kind::text AS kind, a.provider,
      sum(e.amount)::text AS amount, count(DISTINCT tx.id)::int AS transactions
    FROM tx
    JOIN ${ledgerEntries} e ON e.transaction_id = tx.id
    JOIN ${ledgerAccounts} a ON a.id = e.account_id
    GROUP BY 1, 2, 3, 4, 5, 6
  `);
  const byDay = new Map<string, ReportTotal[]>();
  for (const row of result.rows) {
    const list = byDay.get(row.day) ?? [];
    list.push({
      category: row.category as ReportCategory,
      channel: row.channel as ReportChannel,
      kind: row.kind,
      provider: row.provider,
      type: row.type,
      amount: BigInt(row.amount),
      transactions: Number(row.transactions),
    });
    byDay.set(row.day, list);
  }
  for (const [day, list] of byDay) byDay.set(day, addReportTotals(list));
  return byDay;
}

/** How many postings in [start, end) do not sum to zero on their own (must be 0). */
export async function countUnbalancedPostings(
  exec: DbExecutor,
  range: { start: Date; end: Date | null },
): Promise<number> {
  const end = range.end === null ? null : range.end.toISOString();
  const result = await exec.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM (
      SELECT t.id FROM ${ledgerTransactions} t
      JOIN ${ledgerEntries} e ON e.transaction_id = t.id
      WHERE t.created_at >= ${range.start.toISOString()}::timestamptz
        AND (${end}::timestamptz IS NULL OR t.created_at < ${end}::timestamptz)
      GROUP BY t.id HAVING sum(e.amount) <> 0
    ) unbalanced
  `);
  return Number(result.rows[0]?.n ?? 0);
}

/** Every balance at `at` (Σ of all postings before it), by kind and provider (balanceKey). */
export async function loadBalancesAt(exec: DbExecutor, at: Date): Promise<Map<string, bigint>> {
  const result = await exec.execute<{ kind: string; provider: string | null; amount: string }>(sql`
    SELECT a.kind::text AS kind, a.provider, sum(e.amount)::text AS amount
    FROM ${ledgerEntries} e
    JOIN ${ledgerTransactions} t ON t.id = e.transaction_id
    JOIN ${ledgerAccounts} a ON a.id = e.account_id
    WHERE t.created_at < ${at.toISOString()}::timestamptz
    GROUP BY 1, 2
  `);
  return toBalanceMap(result.rows);
}

/** The accounts' stored balances now, by kind and provider (what the ledger says this instant). */
export async function loadStoredBalances(exec: DbExecutor): Promise<Map<string, bigint>> {
  const result = await exec.execute<{ kind: string; provider: string | null; amount: string }>(sql`
    SELECT kind::text AS kind, provider, sum(balance)::text AS amount
    FROM ${ledgerAccounts} GROUP BY 1, 2
  `);
  return toBalanceMap(result.rows);
}

function toBalanceMap(
  rows: ReadonlyArray<{ kind: string; provider: string | null; amount: string }>,
): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const row of rows) {
    const amount = BigInt(row.amount);
    if (amount !== 0n) map.set(balanceKey(row.kind, row.provider), amount);
  }
  return map;
}

/** opening + movements, keys with 0 dropped. */
function rollForward(opening: Map<string, bigint>, totals: readonly ReportTotal[]) {
  const closing = new Map(opening);
  for (const [key, moved] of movementsByKind(totals)) {
    closing.set(key, (closing.get(key) ?? 0n) + moved);
  }
  for (const [key, amount] of closing) if (amount === 0n) closing.delete(key);
  return closing;
}

/** The keys whose amounts differ (missing = 0). */
function balanceDifferences(
  expected: Map<string, bigint>,
  actual: Map<string, bigint>,
): Array<{ key: string; expected: bigint; actual: bigint }> {
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  return [...keys]
    .sort()
    .map((key) => ({ key, expected: expected.get(key) ?? 0n, actual: actual.get(key) ?? 0n }))
    .filter((d) => d.expected !== d.actual);
}

const storeTotals = (totals: readonly ReportTotal[]): StoredReportTotal[] =>
  sortReportTotals(totals).map((t) => [
    t.category,
    t.channel,
    t.kind,
    t.provider,
    t.type,
    t.amount.toString(),
    t.transactions,
  ]);

/** SHA-256 (hex) of a day's canonical totals. */
export function reportTotalsHash(totals: readonly ReportTotal[]): string {
  return createHash('sha256')
    .update(JSON.stringify(storeTotals(totals)))
    .digest('hex');
}

const storeBalances = (balances: Map<string, bigint>): Record<string, string> =>
  Object.fromEntries(
    [...balances.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v.toString()]),
  );

const readBalances = (stored: Record<string, string>): Map<string, bigint> =>
  new Map(Object.entries(stored).map(([k, v]) => [k, BigInt(v)]));

/** How long after midnight a day may be closed (a posting still committing has landed by then). */
export const REPORT_CLOSE_GRACE_MS = 10 * 60_000;

export interface ClosedDay {
  businessDate: string;
  closedNow: boolean;
  checks: StoredReportChecks;
}

/**
 * Closes the business day `date` once it is over (10 minutes after midnight in Addis Ababa): its
 * totals, the closing balances (Σ of every posting before the next midnight, computed on their
 * own) and the close-time checks, written once. A day already closed is returned as it is. Run it
 * in a REPEATABLE READ transaction.
 */
export async function closeReportDay(
  exec: DbExecutor,
  input: { date: string; now: Date },
): Promise<ClosedDay> {
  const window = businessDayWindow(input.date);
  if (input.now.getTime() < window.end.getTime() + REPORT_CLOSE_GRACE_MS) {
    throw new RangeError(`report day ${input.date} is not over yet`);
  }
  const [existing] = await exec
    .select()
    .from(reportDays)
    .where(eq(reportDays.businessDate, input.date))
    .limit(1);
  if (existing) return { businessDate: input.date, closedNow: false, checks: existing.checks };

  const totals =
    (await loadReportTotalsByDay(exec, window)).get(input.date) ?? ([] as ReportTotal[]);
  const closing = await loadBalancesAt(exec, window.end);
  const unbalanced = await countUnbalancedPostings(exec, window);
  const [previous] = await exec
    .select({ closing: reportDays.closing })
    .from(reportDays)
    .where(eq(reportDays.businessDate, addBusinessDays(input.date, -1)))
    .limit(1);
  const checks: StoredReportChecks = {
    balanced: reportImbalance(totals) === 0n,
    everyPostingBalanced: unbalanced === 0,
    rollForward:
      previous === undefined
        ? null
        : balanceDifferences(rollForward(readBalances(previous.closing), totals), closing)
            .length === 0,
  };
  await exec
    .insert(reportDays)
    .values({
      businessDate: input.date,
      totals: storeTotals(totals),
      totalsHash: reportTotalsHash(totals),
      closing: storeBalances(closing),
      checks,
      closedAt: input.now,
    })
    .onConflictDoNothing({ target: reportDays.businessDate });
  return { businessDate: input.date, closedNow: true, checks };
}

/** The days a closed-day check found different from their close (empty: none). */
export async function changedReportDays(
  exec: DbExecutor,
  range: { from: string; to: string },
): Promise<string[]> {
  const stored = await exec
    .select({ date: reportDays.businessDate, hash: reportDays.totalsHash })
    .from(reportDays)
    .where(and(gte(reportDays.businessDate, range.from), lte(reportDays.businessDate, range.to)));
  if (stored.length === 0) return [];
  const live = await loadReportTotalsByDay(exec, {
    start: businessDayWindow(range.from).start,
    end: businessDayWindow(range.to).end,
  });
  return stored
    .filter((row) => reportTotalsHash(live.get(row.date) ?? []) !== row.hash)
    .map((row) => row.date)
    .sort();
}

export type ReportCheckId =
  | 'balanced'
  | 'every_posting_balanced'
  | 'unchanged_since_close'
  | 'closed_days_passed'
  | 'balances_roll_forward';

export interface ReportCheck {
  id: ReportCheckId;
  ok: boolean;
  /** What went wrong, for a failed check (days, balance keys and amounts). */
  detail: string | null;
}

export interface OwnerReport {
  window: ReportWindow;
  /** The period has not ended yet: its figures run until `asOf`. */
  open: boolean;
  asOf: Date;
  figures: ReportFigures;
  totals: ReportTotal[];
  opening: Map<string, bigint>;
  closing: Map<string, bigint>;
  checks: ReportCheck[];
  /** Each day of the period up to today: closed or not, and whether it changed since its close. */
  days: Array<{ date: string; closed: boolean; changed: boolean }>;
}

/**
 * The report of the `period` (day, week, month, year) holding business date `date`, as of `now`.
 * Run it in a REPEATABLE READ transaction, so the figures and the balances read one snapshot.
 */
export async function getOwnerReport(
  exec: DbExecutor,
  input: { period: ReportPeriod; date: string; now: Date },
): Promise<OwnerReport> {
  const window = reportWindow(input.period, input.date);
  const open = window.end.getTime() > input.now.getTime();
  const today = businessDateOf(input.now);
  const byDay = await loadReportTotalsByDay(exec, {
    start: window.start,
    end: open ? null : window.end,
  });
  const totals = addReportTotals(...byDay.values());
  const unbalanced = await countUnbalancedPostings(exec, {
    start: window.start,
    end: open ? null : window.end,
  });
  const closedRows = await exec
    .select()
    .from(reportDays)
    .where(
      and(
        gte(reportDays.businessDate, addBusinessDays(window.firstDay, -1)),
        lte(reportDays.businessDate, window.lastDay),
      ),
    )
    .orderBy(asc(reportDays.businessDate));
  const closedByDate = new Map<string, ReportDay>(closedRows.map((row) => [row.businessDate, row]));

  const days = window.days
    .filter((day) => day <= today)
    .map((date) => {
      const closed = closedByDate.get(date);
      return {
        date,
        closed: closed !== undefined,
        changed:
          closed !== undefined && reportTotalsHash(byDay.get(date) ?? []) !== closed.totalsHash,
      };
    });
  const changed = days.filter((d) => d.changed).map((d) => d.date);
  const failedAtClose = days
    .map((d) => closedByDate.get(d.date))
    .filter(
      (row): row is ReportDay =>
        row !== undefined &&
        (!row.checks.balanced ||
          !row.checks.everyPostingBalanced ||
          row.checks.rollForward === false),
    )
    .map((row) => row.businessDate);

  // Opening: the close of the day before (else computed now). Closing, independently: the period's
  // last day's close, or the accounts' stored balances while the period is open.
  const before = closedByDate.get(addBusinessDays(window.firstDay, -1));
  const opening = before ? readBalances(before.closing) : await loadBalancesAt(exec, window.start);
  const last = closedByDate.get(window.lastDay);
  const closing = open
    ? await loadStoredBalances(exec)
    : last
      ? readBalances(last.closing)
      : await loadBalancesAt(exec, window.end);
  const drift = balanceDifferences(rollForward(opening, totals), closing);

  const imbalance = reportImbalance(totals);
  const checks: ReportCheck[] = [
    {
      id: 'balanced',
      ok: imbalance === 0n,
      detail: imbalance === 0n ? null : `the period's postings sum to ${imbalance} santim`,
    },
    {
      id: 'every_posting_balanced',
      ok: unbalanced === 0,
      detail: unbalanced === 0 ? null : `${unbalanced} posting(s) do not sum to zero`,
    },
    {
      id: 'unchanged_since_close',
      ok: changed.length === 0,
      detail: changed.length === 0 ? null : `changed after their close: ${changed.join(', ')}`,
    },
    {
      id: 'closed_days_passed',
      ok: failedAtClose.length === 0,
      detail:
        failedAtClose.length === 0
          ? null
          : `failed a check at their close: ${failedAtClose.join(', ')}`,
    },
    {
      id: 'balances_roll_forward',
      ok: drift.length === 0,
      detail:
        drift.length === 0
          ? null
          : drift
              .slice(0, 5)
              .map((d) => `${d.key}: expected ${d.expected}, found ${d.actual}`)
              .join('; '),
    },
  ];
  return {
    window,
    open,
    asOf: open ? input.now : window.end,
    figures: summarizeReport(totals),
    totals,
    opening,
    closing,
    checks,
    days,
  };
}

/** The first business date with a posting, or null when the ledger is empty. */
export async function firstLedgerDate(exec: DbExecutor): Promise<string | null> {
  const [row] = await exec
    .select({
      date: sql<
        string | null
      >`((min(${ledgerTransactions.createdAt}) AT TIME ZONE 'UTC') + interval '3 hours')::date::text`,
    })
    .from(ledgerTransactions);
  return row?.date ?? null;
}

/** The last closed business date, or null. */
export async function lastClosedReportDate(exec: DbExecutor): Promise<string | null> {
  const [row] = await exec
    .select({ date: sql<string | null>`max(${reportDays.businessDate})::text` })
    .from(reportDays);
  return row?.date ?? null;
}

import { addBusinessDays, businessDateOf, businessDayWindow, isBusinessDate } from '@vamos/core';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { domainBadRequest, domainNotFound } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { OPEN_PAYOUT_STATUSES } from '../payments/types';
import { bets } from '../schema/betting';
import { dailySummaries, reconciliationMismatches, reconciliationRuns } from '../schema/compliance';
import { jackpotEntries } from '../schema/jackpots';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';
import { paymentIntents, payouts } from '../schema/payments';
import { computeDailyFigures, dailyFiguresHash } from './daily-summary';

/**
 * Reconciliation (worker daily, and on demand from the back office): every
 * check reads one consistent snapshot (a REPEATABLE READ, read-only
 * transaction), so money moving meanwhile cannot show as a difference.
 *
 * Ledger integrity:
 * - ledger_transactions: every transaction has at least two entries summing to zero;
 * - ledger_accounts: each house account's cached balance equals the sum of its
 *   entries and its last balance_after;
 * - balance_after: each entry's balance_after = the previous one's + its amount;
 * Wallets:
 * - wallet: each player cash / bonus balance equals the sum of its entries and
 *   its last balance_after, and is not negative;
 * House accounts against the business rows:
 * - house_stakes = Σ stakes of open and pending bets;
 * - house_jackpot = Σ entry costs − Σ prizes paid (gross) − Σ refunds (jackpot
 *   entries are staked into house_jackpot, not house_stakes);
 * - house_withdrawals_pending = Σ open payouts (requested, approved, processing);
 * Payment providers, for one business day (ledger posting time):
 * - psp_movements: every house_psp_clearing posting belongs to a succeeded
 *   deposit intent (−amount, same provider, its ledger transaction) or a paid
 *   payout (+amount), and nothing else moves those accounts;
 * - psp_records: every intent that succeeded and payout paid that day has
 *   exactly that PSP clearing entry;
 * - psp_daily_totals: per provider, Σ succeeded intents = deposits through
 *   its clearing account and Σ paid payouts = withdrawals through it;
 * Reports:
 * - daily_summary: the final daily summaries of the week up to that day
 *   still equal a recomputation from the ledger.
 * Imported PSP statements are matched line by line in psp-statements.ts
 * (their own runs, kind `psp_statement`).
 *
 * A run with differences writes the outbox alert
 * compliance.reconciliation_mismatch and the audit record
 * `reconciliation.mismatch_detected`; the back office lists the runs.
 */

export const RECONCILIATION_CHECKS = [
  'ledger_transactions',
  'ledger_accounts',
  'balance_after',
  'wallet',
  'house_stakes',
  'house_jackpot',
  'house_withdrawals_pending',
  'psp_movements',
  'psp_records',
  'psp_daily_totals',
  'daily_summary',
] as const;
export type ReconciliationCheck = (typeof RECONCILIATION_CHECKS)[number] | 'psp_statement';

/** Outbox alert of a reconciliation run (or statement import) that found differences. */
export const RECONCILIATION_MISMATCH = 'compliance.reconciliation_mismatch';

/** Differences stored per check and run (the check's summary still counts them all). */
export const MAX_MISMATCHES_PER_CHECK = 500;
/** How many days of final summaries the daily_summary check recomputes. */
const SUMMARY_DRIFT_DAYS = 7;

export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
export type ReconciliationMismatch = typeof reconciliationMismatches.$inferSelect;

export interface MismatchInput {
  check: ReconciliationCheck;
  subjectType: string;
  subjectId: string;
  expected: string | null;
  actual: string | null;
  details?: Record<string, unknown>;
}

export interface CheckSummary {
  check: ReconciliationCheck;
  ok: boolean;
  /** Things looked at (transactions, accounts, entries, bets, postings…). */
  checked: number;
  /** Differences found (all of them, even beyond those stored). */
  mismatches: number;
}

interface CheckResult {
  summary: CheckSummary;
  mismatches: MismatchInput[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rows of `query` (at most `cap`) and how many there are in all. */
async function capped<T extends Record<string, unknown>>(
  exec: DbExecutor,
  query: SQL,
  cap: number,
): Promise<{ rows: T[]; total: number }> {
  const found = await exec.execute(sql`SELECT * FROM (${query}) AS found LIMIT ${cap}`);
  const rows = found.rows as T[];
  if (rows.length < cap) return { rows, total: rows.length };
  const counted = await exec.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM (${query}) AS found`,
  );
  return { rows, total: Number(counted.rows[0]?.n ?? rows.length) };
}

async function countOf(exec: DbExecutor, query: SQL): Promise<number> {
  const result = await exec.execute<{ n: number }>(query);
  return Number(result.rows[0]?.n ?? 0);
}

function result(
  check: ReconciliationCheck,
  checked: number,
  total: number,
  mismatches: MismatchInput[],
): CheckResult {
  return { summary: { check, ok: total === 0, checked, mismatches: total }, mismatches };
}

async function checkTransactions(exec: DbExecutor, cap: number): Promise<CheckResult> {
  const found = await capped<{ id: string; entries: number; total: string }>(
    exec,
    sql`SELECT t.id::text AS id, count(e.id)::int AS entries, COALESCE(sum(e.amount), 0)::text AS total
        FROM ${ledgerTransactions} t
        LEFT JOIN ${ledgerEntries} e ON e.transaction_id = t.id
        GROUP BY t.id
        HAVING count(e.id) < 2 OR COALESCE(sum(e.amount), 0) <> 0`,
    cap,
  );
  const checked = await countOf(exec, sql`SELECT count(*)::int AS n FROM ${ledgerTransactions}`);
  return result(
    'ledger_transactions',
    checked,
    found.total,
    found.rows.map((row) => ({
      check: 'ledger_transactions',
      subjectType: 'ledger_transaction',
      subjectId: row.id,
      expected: 'at least 2 entries summing to 0',
      actual: `${row.entries} entries summing to ${row.total}`,
    })),
  );
}

async function checkAccounts(
  exec: DbExecutor,
  cap: number,
  scope: 'house' | 'player',
): Promise<CheckResult> {
  const players = scope === 'player';
  const found = await capped<{
    key: string;
    kind: string;
    user_id: string | null;
    balance: string;
    total: string;
    last_after: string | null;
  }>(
    exec,
    sql`SELECT a.key, a.kind::text AS kind, a.user_id::text AS user_id, a.balance::text AS balance,
          COALESCE(s.total, 0)::text AS total, s.last_after::text AS last_after
        FROM ${ledgerAccounts} a
        LEFT JOIN (
          SELECT account_id, sum(amount) AS total,
            (array_agg(balance_after ORDER BY id DESC))[1] AS last_after
          FROM ${ledgerEntries} GROUP BY account_id
        ) s ON s.account_id = a.id
        WHERE a.owner_type = ${players ? 'user' : 'house'}
          AND (a.balance <> COALESCE(s.total, 0)
            OR a.balance <> COALESCE(s.last_after, 0)
            ${players ? sql`OR a.balance < 0` : sql``})`,
    cap,
  );
  const checked = await countOf(
    exec,
    sql`SELECT count(*)::int AS n FROM ${ledgerAccounts} WHERE owner_type = ${players ? 'user' : 'house'}`,
  );
  const check = players ? 'wallet' : 'ledger_accounts';
  return result(
    check,
    checked,
    found.total,
    found.rows.map((row) => ({
      check,
      subjectType: players ? 'player' : 'ledger_account',
      subjectId: players ? (row.user_id ?? row.key) : row.key,
      expected: row.total,
      actual: row.balance,
      details: {
        account: row.key,
        kind: row.kind,
        cachedBalance: row.balance,
        sumOfEntries: row.total,
        lastBalanceAfter: row.last_after,
      },
    })),
  );
}

async function checkBalanceAfter(exec: DbExecutor, cap: number): Promise<CheckResult> {
  const found = await capped<{
    id: string;
    key: string;
    amount: string;
    balance_after: string;
    previous: string | null;
  }>(
    exec,
    sql`SELECT x.id::text AS id, a.key, x.amount::text AS amount, x.balance_after::text AS balance_after,
          x.previous::text AS previous
        FROM (
          SELECT e.id, e.account_id, e.amount, e.balance_after,
            lag(e.balance_after) OVER (PARTITION BY e.account_id ORDER BY e.id) AS previous
          FROM ${ledgerEntries} e
        ) x
        JOIN ${ledgerAccounts} a ON a.id = x.account_id
        WHERE x.balance_after <> COALESCE(x.previous, 0) + x.amount`,
    cap,
  );
  const checked = await countOf(exec, sql`SELECT count(*)::int AS n FROM ${ledgerEntries}`);
  return result(
    'balance_after',
    checked,
    found.total,
    found.rows.map((row) => ({
      check: 'balance_after',
      subjectType: 'ledger_entry',
      subjectId: row.id,
      expected: (BigInt(row.previous ?? '0') + BigInt(row.amount)).toString(),
      actual: row.balance_after,
      details: { account: row.key, amount: row.amount, previousBalanceAfter: row.previous },
    })),
  );
}

async function houseBalance(exec: DbExecutor, key: string): Promise<bigint> {
  const [row] = await exec
    .select({ balance: ledgerAccounts.balance })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.key, key));
  return row?.balance ?? 0n;
}

async function checkHouseAccounts(exec: DbExecutor): Promise<CheckResult[]> {
  const [open] = await exec
    .select({
      n: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(sum(${bets.stake}), 0)::text`,
    })
    .from(bets)
    .where(sql`${bets.status} IN ('open', 'pending_acceptance')`);
  const [jackpot] = await exec
    .select({
      n: sql<number>`count(*)::int`,
      total: sql<string>`(COALESCE(sum(${jackpotEntries.cost}), 0)
        - COALESCE(sum(${jackpotEntries.prizeGross}) FILTER (WHERE ${jackpotEntries.status} = 'won'), 0)
        - COALESCE(sum(${jackpotEntries.cost}) FILTER (WHERE ${jackpotEntries.status} = 'void'), 0))::text`,
    })
    .from(jackpotEntries);
  const openStatuses = sql.join(
    OPEN_PAYOUT_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const [held] = await exec
    .select({
      n: sql<number>`count(*)::int`,
      total: sql<string>`COALESCE(sum(${payouts.amount}), 0)::text`,
    })
    .from(payouts)
    .where(sql`${payouts.status}::text IN (${openStatuses})`);
  const compare = async (
    check: ReconciliationCheck,
    key: string,
    expected: { n: number; total: string } | undefined,
    what: string,
  ): Promise<CheckResult> => {
    const balance = await houseBalance(exec, key);
    const total = BigInt(expected?.total ?? '0');
    const mismatches: MismatchInput[] =
      balance === total
        ? []
        : [
            {
              check,
              subjectType: 'ledger_account',
              subjectId: key,
              expected: total.toString(),
              actual: balance.toString(),
              details: { what, rows: expected?.n ?? 0, difference: (balance - total).toString() },
            },
          ];
    return result(check, (expected?.n ?? 0) + 1, mismatches.length, mismatches);
  };
  return [
    await compare('house_stakes', 'house:stakes', open, 'stakes of open and pending bets'),
    await compare(
      'house_jackpot',
      'house:jackpot',
      jackpot,
      'jackpot entry costs minus prizes paid and refunds',
    ),
    await compare(
      'house_withdrawals_pending',
      'house:withdrawals_pending',
      held,
      'open payouts (requested, approved, processing)',
    ),
  ];
}

interface PspMovementRow extends Record<string, unknown> {
  tx_id: string;
  type: string;
  ref_type: string | null;
  ref_id: string | null;
  provider: string | null;
  amount: string;
  intent_id: string | null;
  intent_status: string | null;
  intent_amount: string | null;
  intent_provider: string | null;
  intent_tx: string | null;
  payout_id: string | null;
  payout_status: string | null;
  payout_amount: string | null;
  payout_provider: string | null;
  payout_tx: string | null;
}

/** Why a PSP clearing posting does not belong to its intent or payout (null when it does). */
function movementProblem(row: PspMovementRow): string | null {
  const amount = BigInt(row.amount);
  if (row.type === 'deposit') {
    if (row.intent_id === null) return 'no deposit intent for this posting';
    if (row.intent_status !== 'succeeded')
      return `the deposit intent is ${row.intent_status ?? '?'}`;
    if (row.intent_tx !== row.tx_id) return 'the deposit intent names another ledger transaction';
    if (row.intent_provider !== row.provider) return 'the deposit intent is of another provider';
    if (row.intent_amount === null || -amount !== BigInt(row.intent_amount)) {
      return 'the amount differs from the deposit intent';
    }
    return null;
  }
  if (row.type === 'withdrawal') {
    if (row.payout_id === null) return 'no payout for this posting';
    if (row.payout_status !== 'paid') return `the payout is ${row.payout_status ?? '?'}`;
    if (row.payout_tx !== row.tx_id) return 'the payout names another ledger transaction';
    if (row.payout_provider !== row.provider) return 'the payout is of another provider';
    if (row.payout_amount === null || amount !== BigInt(row.payout_amount)) {
      return 'the amount differs from the payout';
    }
    return null;
  }
  return `a ${row.type} posting moved a PSP clearing account`;
}

async function checkPayments(exec: DbExecutor, date: string, cap: number): Promise<CheckResult[]> {
  const { start, end } = businessDayWindow(date);
  const from = start.toISOString();
  const to = end.toISOString();
  const movements = await exec.execute<PspMovementRow>(sql`
    SELECT t.id::text AS tx_id, t.type::text AS type, t.ref_type, t.ref_id, a.provider,
      e.amount::text AS amount,
      i.id::text AS intent_id, i.status::text AS intent_status, i.amount::text AS intent_amount,
      i.provider AS intent_provider, i.ledger_transaction_id::text AS intent_tx,
      p.id::text AS payout_id, p.status::text AS payout_status, p.amount::text AS payout_amount,
      p.provider AS payout_provider, p.paid_ledger_transaction_id::text AS payout_tx
    FROM ${ledgerEntries} e
    JOIN ${ledgerAccounts} a ON a.id = e.account_id
    JOIN ${ledgerTransactions} t ON t.id = e.transaction_id
    LEFT JOIN ${paymentIntents} i ON t.ref_type = 'payment_intent' AND i.id::text = t.ref_id
    LEFT JOIN ${payouts} p ON t.ref_type = 'payout' AND p.id::text = t.ref_id
    WHERE a.kind = 'house_psp_clearing'
      AND t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz
    ORDER BY t.created_at, t.id
  `);
  const movementMismatches: MismatchInput[] = [];
  let movementTotal = 0;
  /** provider → ledger deposits / withdrawals through its clearing account. */
  const ledgerTotals = new Map<string, { deposits: bigint; withdrawals: bigint }>();
  for (const row of movements.rows) {
    const provider = row.provider ?? '?';
    const totals = ledgerTotals.get(provider) ?? { deposits: 0n, withdrawals: 0n };
    if (row.type === 'deposit') totals.deposits -= BigInt(row.amount);
    if (row.type === 'withdrawal') totals.withdrawals += BigInt(row.amount);
    ledgerTotals.set(provider, totals);
    const problem = movementProblem(row);
    if (problem === null) continue;
    movementTotal += 1;
    if (movementMismatches.length < cap) {
      movementMismatches.push({
        check: 'psp_movements',
        subjectType: 'ledger_transaction',
        subjectId: row.tx_id,
        expected: row.intent_amount ?? row.payout_amount,
        actual: row.amount,
        details: {
          problem,
          provider: row.provider,
          type: row.type,
          refType: row.ref_type,
          refId: row.ref_id,
        },
      });
    }
  }

  const records = await exec.execute<{
    kind: 'deposit' | 'payout';
    id: string;
    provider: string;
    amount: string;
    tx_id: string | null;
    tx_found: boolean;
    psp_entries: number;
    psp_amount: string | null;
    psp_provider: string | null;
  }>(sql`
    SELECT 'deposit' AS kind, i.id::text AS id, i.provider, i.amount::text AS amount,
      i.ledger_transaction_id::text AS tx_id, (t.id IS NOT NULL) AS tx_found,
      x.n AS psp_entries, x.total::text AS psp_amount, x.provider AS psp_provider
    FROM ${paymentIntents} i
    LEFT JOIN ${ledgerTransactions} t ON t.id = i.ledger_transaction_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, sum(e.amount) AS total, min(a.provider) AS provider
      FROM ${ledgerEntries} e JOIN ${ledgerAccounts} a ON a.id = e.account_id
      WHERE e.transaction_id = i.ledger_transaction_id AND a.kind = 'house_psp_clearing'
    ) x ON true
    WHERE i.status = 'succeeded'
      AND ((t.id IS NOT NULL AND t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz)
        OR (t.id IS NULL AND i.completed_at >= ${from}::timestamptz AND i.completed_at < ${to}::timestamptz))
    UNION ALL
    SELECT 'payout' AS kind, p.id::text AS id, p.provider, p.amount::text AS amount,
      p.paid_ledger_transaction_id::text AS tx_id, (t.id IS NOT NULL) AS tx_found,
      x.n AS psp_entries, x.total::text AS psp_amount, x.provider AS psp_provider
    FROM ${payouts} p
    LEFT JOIN ${ledgerTransactions} t ON t.id = p.paid_ledger_transaction_id
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, sum(e.amount) AS total, min(a.provider) AS provider
      FROM ${ledgerEntries} e JOIN ${ledgerAccounts} a ON a.id = e.account_id
      WHERE e.transaction_id = p.paid_ledger_transaction_id AND a.kind = 'house_psp_clearing'
    ) x ON true
    WHERE p.status = 'paid'
      AND ((t.id IS NOT NULL AND t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz)
        OR (t.id IS NULL AND p.completed_at >= ${from}::timestamptz AND p.completed_at < ${to}::timestamptz))
  `);
  const recordMismatches: MismatchInput[] = [];
  let recordTotal = 0;
  const recordTotals = new Map<string, { deposits: bigint; withdrawals: bigint }>();
  for (const row of records.rows) {
    const totals = recordTotals.get(row.provider) ?? { deposits: 0n, withdrawals: 0n };
    const amount = BigInt(row.amount);
    if (row.kind === 'deposit') totals.deposits += amount;
    else totals.withdrawals += amount;
    recordTotals.set(row.provider, totals);
    const expected = row.kind === 'deposit' ? -amount : amount;
    let problem: string | null = null;
    if (!row.tx_found) problem = 'its ledger transaction does not exist';
    else if (Number(row.psp_entries ?? 0) !== 1)
      problem = 'its ledger transaction has no PSP clearing entry';
    else if (row.psp_provider !== row.provider)
      problem = 'its PSP clearing entry is of another provider';
    else if (BigInt(row.psp_amount ?? '0') !== expected)
      problem = 'its PSP clearing entry has another amount';
    if (problem === null) continue;
    recordTotal += 1;
    if (recordMismatches.length < cap) {
      recordMismatches.push({
        check: 'psp_records',
        subjectType: row.kind === 'deposit' ? 'payment_intent' : 'payout',
        subjectId: row.id,
        expected: expected.toString(),
        actual: row.psp_amount,
        details: { problem, provider: row.provider, ledgerTransactionId: row.tx_id },
      });
    }
  }

  const totalMismatches: MismatchInput[] = [];
  const providers = new Set([...ledgerTotals.keys(), ...recordTotals.keys()]);
  for (const provider of [...providers].sort()) {
    const ledger = ledgerTotals.get(provider) ?? { deposits: 0n, withdrawals: 0n };
    const recorded = recordTotals.get(provider) ?? { deposits: 0n, withdrawals: 0n };
    for (const side of ['deposits', 'withdrawals'] as const) {
      if (ledger[side] === recorded[side]) continue;
      totalMismatches.push({
        check: 'psp_daily_totals',
        subjectType: 'psp_provider_day',
        subjectId: `${provider}:${date}`,
        expected: recorded[side].toString(),
        actual: ledger[side].toString(),
        details: {
          provider,
          businessDate: date,
          side,
          records: side === 'deposits' ? 'deposit intents succeeded' : 'payouts paid',
          ledger: 'house_psp_clearing movements',
        },
      });
    }
  }
  return [
    result('psp_movements', movements.rows.length, movementTotal, movementMismatches),
    result('psp_records', records.rows.length, recordTotal, recordMismatches),
    result('psp_daily_totals', providers.size * 2, totalMismatches.length, totalMismatches),
  ];
}

async function checkDailySummaries(exec: DbExecutor, date: string): Promise<CheckResult> {
  const from = addBusinessDays(date, -(SUMMARY_DRIFT_DAYS - 1));
  const finals = await exec
    .select()
    .from(dailySummaries)
    .where(
      and(
        eq(dailySummaries.status, 'final'),
        sql`${dailySummaries.businessDate} BETWEEN ${from} AND ${date}`,
      ),
    )
    .orderBy(asc(dailySummaries.businessDate));
  const mismatches: MismatchInput[] = [];
  for (const summary of finals) {
    const figures = await computeDailyFigures(exec, summary.businessDate, {
      commissionRateBps: summary.commissionRateBps,
    });
    const hash = dailyFiguresHash(summary.businessDate, figures);
    if (hash === summary.hash) continue;
    mismatches.push({
      check: 'daily_summary',
      subjectType: 'daily_summary',
      subjectId: summary.businessDate,
      expected: summary.hash,
      actual: hash,
      details: {
        finalTurnover: summary.turnover.toString(),
        ledgerTurnover: figures.turnover.toString(),
        finalPayouts: summary.payouts.toString(),
        ledgerPayouts: figures.payouts.toString(),
        finalGgr: summary.ggr.toString(),
        ledgerGgr: figures.ggr.toString(),
      },
    });
  }
  return result('daily_summary', finals.length, mismatches.length, mismatches);
}

/** Runs every check on one snapshot (the caller's transaction should be REPEATABLE READ). */
export async function runReconciliationChecks(
  exec: DbExecutor,
  input: { businessDate: string; maxMismatchesPerCheck?: number },
): Promise<{ checks: CheckSummary[]; mismatches: MismatchInput[] }> {
  const cap = input.maxMismatchesPerCheck ?? MAX_MISMATCHES_PER_CHECK;
  const results: CheckResult[] = [
    await checkTransactions(exec, cap),
    await checkAccounts(exec, cap, 'house'),
    await checkBalanceAfter(exec, cap),
    await checkAccounts(exec, cap, 'player'),
    ...(await checkHouseAccounts(exec)),
    ...(await checkPayments(exec, input.businessDate, cap)),
    await checkDailySummaries(exec, input.businessDate),
  ];
  return {
    checks: results.map((check) => check.summary),
    mismatches: results.flatMap((check) => check.mismatches),
  };
}

export interface ReconciliationRunDetail {
  run: ReconciliationRun;
  /** The stored differences (at most MAX_MISMATCHES_PER_CHECK per check), in check order. */
  mismatches: ReconciliationMismatch[];
}

/**
 * Stores a finished run with its differences, and raises the alert when
 * there are any (outbox compliance.reconciliation_mismatch + audit
 * `reconciliation.mismatch_detected`). A staff-started run is audited as
 * `reconciliation.run`.
 */
export async function recordReconciliationRun(
  tx: DbTransaction,
  input: {
    kind: 'scheduled' | 'manual' | 'psp_statement';
    businessDate: string | null;
    statementId?: string | null;
    triggeredBy: string;
    checks: CheckSummary[];
    mismatches: MismatchInput[];
    error?: string | null;
    startedAt: Date;
    finishedAt: Date;
    ip?: string | null;
  },
): Promise<ReconciliationRunDetail> {
  const mismatchCount =
    input.checks.reduce((sum, check) => sum + check.mismatches, 0) + (input.error ? 1 : 0);
  const status = input.error ? 'failed' : mismatchCount > 0 ? 'mismatches' : 'clean';
  const [run] = await tx
    .insert(reconciliationRuns)
    .values({
      kind: input.kind,
      status,
      businessDate: input.businessDate,
      statementId: input.statementId ?? null,
      triggeredBy: input.triggeredBy,
      checks: input.checks,
      mismatchCount,
      error: input.error ?? null,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    })
    .returning();
  if (run === undefined) throw new Error('reconciliation run insert returned no row');
  const stored: ReconciliationMismatch[] = [];
  for (let i = 0; i < input.mismatches.length; i += 1000) {
    stored.push(
      ...(await tx
        .insert(reconciliationMismatches)
        .values(
          input.mismatches.slice(i, i + 1000).map((mismatch) => ({
            runId: run.id,
            check: mismatch.check,
            subjectType: mismatch.subjectType,
            subjectId: mismatch.subjectId,
            expected: mismatch.expected,
            actual: mismatch.actual,
            details: mismatch.details ?? null,
          })),
        )
        .returning()),
    );
  }
  const staff = input.triggeredBy !== 'system';
  if (staff && input.kind === 'manual') {
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: input.triggeredBy,
      action: 'reconciliation.run',
      targetType: 'reconciliation_run',
      targetId: run.id,
      metadata: { businessDate: input.businessDate, status, mismatchCount },
      ip: input.ip ?? null,
    });
  }
  if (status !== 'clean') {
    const failing = input.checks.filter((check) => !check.ok).map((check) => check.check);
    const payload = {
      runId: run.id,
      kind: input.kind,
      status,
      businessDate: input.businessDate,
      statementId: input.statementId ?? null,
      mismatchCount,
      checks: failing,
      error: input.error ?? null,
    };
    await enqueueOutbox(tx, {
      type: RECONCILIATION_MISMATCH,
      aggregateType: 'reconciliation_run',
      aggregateId: run.id,
      payload,
    });
    await writeAudit(tx, {
      actorType: 'system',
      action: 'reconciliation.mismatch_detected',
      targetType: 'reconciliation_run',
      targetId: run.id,
      metadata: payload,
    });
  }
  return {
    run,
    mismatches: stored.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/**
 * Runs the reconciliation (the worker daily with kind `scheduled`; staff
 * with kind `manual` and their id as `actor`). `businessDate` is the day of
 * the payment checks: by default yesterday for a scheduled run and today
 * for a manual one (Addis Ababa dates). A run whose checks fail with an
 * error is stored as `failed` (and alerted), not thrown.
 */
export async function runReconciliation(
  db: Database,
  input: {
    now: Date;
    kind?: 'scheduled' | 'manual';
    businessDate?: string;
    actor?: { adminId: string; ip?: string | null } | null;
    maxMismatchesPerCheck?: number;
  },
): Promise<ReconciliationRunDetail> {
  const kind = input.kind ?? (input.actor ? 'manual' : 'scheduled');
  const today = businessDateOf(input.now);
  const businessDate =
    input.businessDate ?? (kind === 'scheduled' ? addBusinessDays(today, -1) : today);
  if (!isBusinessDate(businessDate)) {
    throw domainBadRequest('invalid_business_date', 'A business date is written YYYY-MM-DD.', {
      date: businessDate,
    });
  }
  const startedAt = input.now;
  const clockStart = Date.now();
  let outcome: { checks: CheckSummary[]; mismatches: MismatchInput[] };
  let error: string | null = null;
  try {
    outcome = await db.transaction(
      (tx) =>
        runReconciliationChecks(tx, {
          businessDate,
          ...(input.maxMismatchesPerCheck === undefined
            ? {}
            : { maxMismatchesPerCheck: input.maxMismatchesPerCheck }),
        }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 1000);
    outcome = { checks: [], mismatches: [] };
  }
  return db.transaction((tx) =>
    recordReconciliationRun(tx, {
      kind,
      businessDate,
      triggeredBy: input.actor?.adminId ?? 'system',
      checks: outcome.checks,
      mismatches: outcome.mismatches,
      error,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + Math.max(0, Date.now() - clockStart)),
      ip: input.actor?.ip ?? null,
    }),
  );
}

/** Runs newest first (cursor: the id of the last run of the previous page). */
export async function listReconciliationRuns(
  exec: DbExecutor,
  query: {
    kind?: 'scheduled' | 'manual' | 'psp_statement';
    status?: 'clean' | 'mismatches' | 'failed';
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ items: ReconciliationRun[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
  const conditions: SQL[] = [];
  if (query.kind !== undefined) conditions.push(eq(reconciliationRuns.kind, query.kind));
  if (query.status !== undefined) conditions.push(eq(reconciliationRuns.status, query.status));
  if (query.cursor !== undefined) {
    const [after] = UUID_RE.test(query.cursor)
      ? await exec
          .select({ startedAt: reconciliationRuns.startedAt, id: reconciliationRuns.id })
          .from(reconciliationRuns)
          .where(eq(reconciliationRuns.id, query.cursor))
      : [];
    if (after === undefined) {
      throw domainBadRequest('invalid_cursor', 'This page cursor is not valid.');
    }
    conditions.push(
      sql`(${reconciliationRuns.startedAt}, ${reconciliationRuns.id}) < (${after.startedAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
    );
  }
  const rows = await exec
    .select()
    .from(reconciliationRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reconciliationRuns.startedAt), desc(reconciliationRuns.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null };
}

/** One run with its stored differences. */
export async function getReconciliationRun(
  exec: DbExecutor,
  runId: string,
): Promise<ReconciliationRunDetail> {
  const [run] = UUID_RE.test(runId)
    ? await exec.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, runId))
    : [];
  if (run === undefined) throw domainNotFound('Reconciliation run');
  const mismatches = await exec
    .select()
    .from(reconciliationMismatches)
    .where(eq(reconciliationMismatches.runId, run.id))
    .orderBy(asc(reconciliationMismatches.id));
  return { run, mismatches };
}

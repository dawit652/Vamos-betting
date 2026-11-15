import { addBusinessDays, businessDateOf, businessDayWindow, isBusinessDate } from '@vamos/core';
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { isUniqueViolation } from '../catalog/errors';
import { domainBadRequest, domainConflict, domainNotFound } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { OPEN_PAYOUT_STATUSES } from '../payments/types';
import { bets } from '../schema/betting';
import {
  complianceCursors,
  reconciliationMismatches,
  reconciliationRequests,
  reconciliationRuns,
} from '../schema/compliance';
import { jackpotEntries } from '../schema/jackpots';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';
import { paymentIntents, payouts } from '../schema/payments';

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
 * Imported PSP statements are matched line by line in psp-statements.ts
 * (their own runs, kind `psp_statement`).
 *
 * Cost (Phase 12): balance_after is checked incrementally, from the entry id
 * the last clean run verified (compliance_cursors
 * `reconciliation_balance_after`, moved only past entries written at least
 * BALANCE_AFTER_GRACE_MS before the snapshot, and never past a difference),
 * with a full scan when the last clean one is a week old. What still reads
 * the whole ledger on every run: ledger_transactions (entries per
 * transaction sum to zero) and ledger_accounts / wallet (each account's sum
 * of entries). Both could become incremental the same way (transactions and
 * per-account running sums are append-only), but they also catch a row
 * changed behind the triggers' back, which only a full read can; they stay
 * full until the ledger is large enough to matter (they are single
 * aggregate passes, a few seconds per million entries).
 *
 * Staff "Run now" runs in the worker: requestReconciliation queues a
 * reconciliation_requests row (one at a time) and the outbox event
 * compliance.reconciliation_requested; runRequestedReconciliation runs it
 * with the request's id.
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
] as const;
export type ReconciliationCheck = (typeof RECONCILIATION_CHECKS)[number] | 'psp_statement';

/** Outbox alert of a reconciliation run (or statement import) that found differences. */
export const RECONCILIATION_MISMATCH = 'compliance.reconciliation_mismatch';

/** Differences stored per check and run (the check's summary still counts them all). */
export const MAX_MISMATCHES_PER_CHECK = 500;

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

/** Rows of `query` (at most `cap`) and how many there are in all, in one pass over the query. */
async function capped<T extends Record<string, unknown>>(
  exec: DbExecutor,
  query: SQL,
  cap: number,
): Promise<{ rows: T[]; total: number }> {
  const found = await exec.execute(
    sql`SELECT *, count(*) OVER ()::int AS found_total FROM (${query}) AS found LIMIT ${Math.max(cap, 1)}`,
  );
  const rows = found.rows as Array<T & { found_total: number }>;
  return { rows: rows.slice(0, Math.max(cap, 0)), total: Number(rows[0]?.found_total ?? 0) };
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
    // The sums cover only this scope's accounts (the two scopes read each entry once), and the
    // last balance_after comes from the (account_id, id) index, not an array of every entry.
    sql`SELECT a.key, a.kind::text AS kind, a.user_id::text AS user_id, a.balance::text AS balance,
          COALESCE(s.total, 0)::text AS total, l.balance_after::text AS last_after
        FROM ${ledgerAccounts} a
        LEFT JOIN (
          SELECT e.account_id, sum(e.amount) AS total
          FROM ${ledgerEntries} e
          JOIN ${ledgerAccounts} sa ON sa.id = e.account_id
          WHERE sa.owner_type = ${players ? 'user' : 'house'}
          GROUP BY e.account_id
        ) s ON s.account_id = a.id
        LEFT JOIN LATERAL (
          SELECT le.balance_after FROM ${ledgerEntries} le
          WHERE le.account_id = a.id ORDER BY le.id DESC LIMIT 1
        ) l ON true
        WHERE a.owner_type = ${players ? 'user' : 'house'}
          AND (a.balance <> COALESCE(s.total, 0)
            OR a.balance <> COALESCE(l.balance_after, 0)
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

/**
 * balance_after continuity. A full scan reads every entry (a window over the
 * whole table); an incremental one (`after` set) reads only the entries after
 * that id, each with its account's previous entry from the (account_id, id)
 * index. Entries are append-only (trigger), so an entry checked once stays
 * right. Also returns the next checkpoint: the newest entry id written at
 * least `graceMs` before this snapshot (see BALANCE_AFTER_GRACE_MS).
 */
async function checkBalanceAfter(
  exec: DbExecutor,
  cap: number,
  scope: { after: bigint | null; graceMs: number },
): Promise<CheckResult & { checkpoint: bigint | null }> {
  const incremental = scope.after !== null;
  const after = (scope.after ?? 0n).toString();
  const found = await capped<{
    id: string;
    key: string;
    amount: string;
    balance_after: string;
    previous: string | null;
  }>(
    exec,
    incremental
      ? sql`SELECT x.id::text AS id, a.key, x.amount::text AS amount,
            x.balance_after::text AS balance_after, x.previous::text AS previous
          FROM (
            SELECT e.id, e.account_id, e.amount, e.balance_after,
              (SELECT p.balance_after FROM ${ledgerEntries} p
                WHERE p.account_id = e.account_id AND p.id < e.id
                ORDER BY p.id DESC LIMIT 1) AS previous
            FROM ${ledgerEntries} e
            WHERE e.id > ${after}::bigint
          ) x
          JOIN ${ledgerAccounts} a ON a.id = x.account_id
          WHERE x.balance_after <> COALESCE(x.previous, 0) + x.amount`
      : sql`SELECT x.id::text AS id, a.key, x.amount::text AS amount,
            x.balance_after::text AS balance_after, x.previous::text AS previous
          FROM (
            SELECT e.id, e.account_id, e.amount, e.balance_after,
              lag(e.balance_after) OVER (PARTITION BY e.account_id ORDER BY e.id) AS previous
            FROM ${ledgerEntries} e
          ) x
          JOIN ${ledgerAccounts} a ON a.id = x.account_id
          WHERE x.balance_after <> COALESCE(x.previous, 0) + x.amount`,
    cap,
  );
  const range = await exec.execute<{ n: number; checkpoint: string | null }>(
    sql`SELECT count(*)::int AS n,
          max(id) FILTER (
            WHERE created_at < now() - make_interval(secs => ${scope.graceMs / 1000})
          )::text AS checkpoint
        FROM ${ledgerEntries} WHERE id > ${after}::bigint`,
  );
  const checked = Number(range.rows[0]?.n ?? 0);
  const newest = range.rows[0]?.checkpoint ?? null;
  return {
    ...result(
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
    ),
    checkpoint: newest === null ? scope.after : BigInt(newest),
  };
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

/**
 * How old (by its transaction's start) an entry must be before the
 * balance_after checkpoint moves past it. Entry ids are taken when a row is
 * inserted but become visible at commit, so a ledger transaction still open
 * could commit an id below one already seen; the grace covers that for any
 * transaction shorter than half of it (ledger transactions take
 * milliseconds; the weekly full scan covers the rest).
 */
export const BALANCE_AFTER_GRACE_MS = 30 * 60_000;
/** A full balance_after scan runs when the last one is older than this. */
export const BALANCE_AFTER_FULL_SCAN_EVERY_MS = 7 * 24 * 3600_000;
/** compliance_cursors: the entry id up to which balance_after is verified. */
export const BALANCE_AFTER_CURSOR = 'reconciliation_balance_after';
/** compliance_cursors: when the last clean full balance_after scan ran (epoch ms). */
export const BALANCE_AFTER_FULL_SCAN_CURSOR = 'reconciliation_balance_after_full';

export interface ReconciliationChecksResult {
  checks: CheckSummary[];
  mismatches: MismatchInput[];
  /** How balance_after was checked, and the checkpoint it reached (null: none yet). */
  balanceAfter: { scope: 'full' | 'incremental'; checkpoint: bigint | null };
}

/**
 * Runs every check on one snapshot (the caller's transaction should be
 * REPEATABLE READ). `balanceAfterFrom` makes the balance_after check
 * incremental (entries after that id only); null or absent: a full scan.
 */
export async function runReconciliationChecks(
  exec: DbExecutor,
  input: {
    businessDate: string;
    maxMismatchesPerCheck?: number;
    balanceAfterFrom?: bigint | null;
    balanceAfterGraceMs?: number;
  },
): Promise<ReconciliationChecksResult> {
  const cap = input.maxMismatchesPerCheck ?? MAX_MISMATCHES_PER_CHECK;
  const from = input.balanceAfterFrom ?? null;
  const balanceAfter = await checkBalanceAfter(exec, cap, {
    after: from,
    graceMs: input.balanceAfterGraceMs ?? BALANCE_AFTER_GRACE_MS,
  });
  const results: CheckResult[] = [
    await checkTransactions(exec, cap),
    await checkAccounts(exec, cap, 'house'),
    balanceAfter,
    await checkAccounts(exec, cap, 'player'),
    ...(await checkHouseAccounts(exec)),
    ...(await checkPayments(exec, input.businessDate, cap)),
  ];
  return {
    checks: results.map((check) => check.summary),
    mismatches: results.flatMap((check) => check.mismatches),
    balanceAfter: {
      scope: from === null ? 'full' : 'incremental',
      checkpoint: balanceAfter.checkpoint,
    },
  };
}

/** The balance_after cursors (checkpoint id and last full scan). */
async function balanceAfterCursors(
  exec: DbExecutor,
): Promise<{ checkpoint: bigint | null; lastFullScanMs: number | null }> {
  const rows = await exec
    .select({ name: complianceCursors.name, position: complianceCursors.position })
    .from(complianceCursors)
    .where(inArray(complianceCursors.name, [BALANCE_AFTER_CURSOR, BALANCE_AFTER_FULL_SCAN_CURSOR]));
  const of = (name: string) => rows.find((row) => row.name === name)?.position ?? null;
  const full = of(BALANCE_AFTER_FULL_SCAN_CURSOR);
  return {
    checkpoint: of(BALANCE_AFTER_CURSOR),
    lastFullScanMs: full === null ? null : Number(full),
  };
}

/** Moves a cursor forward (never back). */
async function advanceCursor(tx: DbTransaction, name: string, position: bigint, now: Date) {
  await tx
    .insert(complianceCursors)
    .values({ name, position, updatedAt: now })
    .onConflictDoUpdate({
      target: complianceCursors.name,
      set: {
        position: sql`GREATEST(${complianceCursors.position}, excluded.position)`,
        updatedAt: now,
      },
    });
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
    /** The run's id (a requested run takes its request's id); default a new one. */
    id?: string;
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
      ...(input.id === undefined ? {} : { id: input.id }),
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
    /** The run's id (default a new one). */
    runId?: string;
    /** Runs in the transaction that stores the run (e.g. to close its request). */
    onRecorded?: (tx: DbTransaction, detail: ReconciliationRunDetail) => Promise<void>;
    /** Force a full balance_after scan (default: weekly, incremental in between). */
    fullBalanceAfterScan?: boolean;
    /** Default BALANCE_AFTER_GRACE_MS (tests use 0). */
    balanceAfterGraceMs?: number;
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
  let outcome: ReconciliationChecksResult | null = null;
  let error: string | null = null;
  try {
    outcome = await db.transaction(
      async (tx) => {
        // balance_after: incremental from the verified checkpoint, with a full scan weekly
        // (or when there is no checkpoint yet, or when asked).
        const cursors = await balanceAfterCursors(tx);
        const full =
          input.fullBalanceAfterScan === true ||
          cursors.checkpoint === null ||
          cursors.lastFullScanMs === null ||
          input.now.getTime() - cursors.lastFullScanMs >= BALANCE_AFTER_FULL_SCAN_EVERY_MS;
        return runReconciliationChecks(tx, {
          businessDate,
          balanceAfterFrom: full ? null : cursors.checkpoint,
          ...(input.balanceAfterGraceMs === undefined
            ? {}
            : { balanceAfterGraceMs: input.balanceAfterGraceMs }),
          ...(input.maxMismatchesPerCheck === undefined
            ? {}
            : { maxMismatchesPerCheck: input.maxMismatchesPerCheck }),
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  } catch (caught) {
    error = (caught instanceof Error ? caught.message : String(caught)).slice(0, 1000);
  }
  return db.transaction(async (tx) => {
    const detail = await recordReconciliationRun(tx, {
      ...(input.runId === undefined ? {} : { id: input.runId }),
      kind,
      businessDate,
      triggeredBy: input.actor?.adminId ?? 'system',
      checks: outcome?.checks ?? [],
      mismatches: outcome?.mismatches ?? [],
      error,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + Math.max(0, Date.now() - clockStart)),
      ip: input.actor?.ip ?? null,
    });
    // The checkpoint moves only past entries found continuous: differences found are reported
    // again by every run until they are dealt with.
    const continuous = outcome?.checks.find((check) => check.check === 'balance_after')?.ok;
    if (outcome !== null && continuous === true) {
      if (outcome.balanceAfter.checkpoint !== null) {
        await advanceCursor(tx, BALANCE_AFTER_CURSOR, outcome.balanceAfter.checkpoint, input.now);
      }
      if (outcome.balanceAfter.scope === 'full') {
        await advanceCursor(
          tx,
          BALANCE_AFTER_FULL_SCAN_CURSOR,
          BigInt(input.now.getTime()),
          input.now,
        );
      }
    }
    await input.onRecorded?.(tx, detail);
    return detail;
  });
}

// ---------------------------------------------------------------------------
// Requested runs ("Run now" from the back office, run by the worker).

export type ReconciliationRequest = typeof reconciliationRequests.$inferSelect;

/** Outbox event of a new request: the worker's `reconciliation` queue runs it. */
export const RECONCILIATION_REQUESTED = 'compliance.reconciliation_requested';

/**
 * A request still queued or running after this long is taken as lost (its
 * job exhausted or the worker gone) when staff ask again: it is failed so a
 * new one can start.
 */
export const RECONCILIATION_REQUEST_STALE_MS = 30 * 60_000;

const ONE_OPEN_REQUEST = 'reconciliation_requests_one_open';

/**
 * Queues a staff reconciliation ("Run now"): one request at a time (409
 * `reconciliation_running` while another is queued or running, unless that
 * one is older than `staleAfterMs`, which is then failed as lost). Writes
 * the request, the outbox event compliance.reconciliation_requested (the
 * worker runs it) and the audit record `reconciliation.requested` in one
 * transaction. The run it produces will have the request's id.
 */
export async function requestReconciliation(
  db: Database,
  input: {
    now: Date;
    businessDate?: string;
    actor: { adminId: string; ip?: string | null };
    staleAfterMs?: number;
  },
): Promise<ReconciliationRequest> {
  const businessDate = input.businessDate ?? businessDateOf(input.now);
  if (!isBusinessDate(businessDate)) {
    throw domainBadRequest('invalid_business_date', 'A business date is written YYYY-MM-DD.', {
      date: businessDate,
    });
  }
  const staleBefore = new Date(
    input.now.getTime() - (input.staleAfterMs ?? RECONCILIATION_REQUEST_STALE_MS),
  );
  try {
    return await db.transaction(async (tx) => {
      await tx
        .update(reconciliationRequests)
        .set({
          status: 'failed',
          error: 'abandoned: not finished in time (worker stopped or the job failed)',
          finishedAt: input.now,
        })
        .where(
          and(
            inArray(reconciliationRequests.status, ['queued', 'running']),
            lt(reconciliationRequests.requestedAt, staleBefore),
          ),
        );
      const [request] = await tx
        .insert(reconciliationRequests)
        .values({
          businessDate,
          requestedBy: input.actor.adminId,
          ip: input.actor.ip ?? null,
          requestedAt: input.now,
        })
        .returning();
      if (request === undefined) throw new Error('reconciliation request insert returned no row');
      await enqueueOutbox(tx, {
        type: RECONCILIATION_REQUESTED,
        aggregateType: 'reconciliation_request',
        aggregateId: request.id,
        payload: { requestId: request.id, businessDate },
      });
      await writeAudit(tx, {
        actorType: 'admin',
        actorId: input.actor.adminId,
        action: 'reconciliation.requested',
        targetType: 'reconciliation_request',
        targetId: request.id,
        metadata: { businessDate },
        ip: input.actor.ip ?? null,
      });
      return request;
    });
  } catch (error) {
    if (isUniqueViolation(error, ONE_OPEN_REQUEST)) {
      throw domainConflict(
        'reconciliation_running',
        'A reconciliation is already queued or running. Try again in a minute.',
      );
    }
    throw error;
  }
}

/** One request (404 when unknown). */
export async function getReconciliationRequest(
  exec: DbExecutor,
  requestId: string,
): Promise<ReconciliationRequest> {
  const [request] = UUID_RE.test(requestId)
    ? await exec
        .select()
        .from(reconciliationRequests)
        .where(eq(reconciliationRequests.id, requestId))
    : [];
  if (request === undefined) throw domainNotFound('Reconciliation request');
  return request;
}

export type RequestedReconciliationResult =
  | { ran: true; request: ReconciliationRequest; run: ReconciliationRun }
  | { ran: false; request: ReconciliationRequest | null; reason: 'not_found' | 'finished' };

/**
 * Runs a queued request (the worker's `reconciliation` job): marks it
 * running, runs the reconciliation as a manual run of the staff member with
 * the request's id, and marks it done in the transaction that stores the
 * run. Safe to replay: a finished request is left alone, and a run already
 * stored under the id (a crash between the two) just closes the request.
 */
export async function runRequestedReconciliation(
  db: Database,
  input: { requestId: string; now: Date; maxMismatchesPerCheck?: number },
): Promise<RequestedReconciliationResult> {
  const [claimed] = await db
    .update(reconciliationRequests)
    .set({
      status: 'running',
      startedAt: input.now,
      attempts: sql`${reconciliationRequests.attempts} + 1`,
    })
    .where(
      and(
        eq(reconciliationRequests.id, input.requestId),
        inArray(reconciliationRequests.status, ['queued', 'running']),
      ),
    )
    .returning();
  if (claimed === undefined) {
    const [current] = UUID_RE.test(input.requestId)
      ? await db
          .select()
          .from(reconciliationRequests)
          .where(eq(reconciliationRequests.id, input.requestId))
      : [];
    return current === undefined
      ? { ran: false, request: null, reason: 'not_found' }
      : { ran: false, request: current, reason: 'finished' };
  }
  const markDone = async (exec: DbExecutor, finishedAt: Date) => {
    const [done] = await exec
      .update(reconciliationRequests)
      .set({ status: 'done', runId: claimed.id, finishedAt, error: null })
      .where(eq(reconciliationRequests.id, claimed.id))
      .returning();
    if (done === undefined) throw new Error('reconciliation request vanished');
    return done;
  };
  const [existing] = await db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.id, claimed.id));
  if (existing !== undefined) {
    return { ran: true, request: await markDone(db, existing.finishedAt), run: existing };
  }
  let request: ReconciliationRequest = claimed;
  const detail = await runReconciliation(db, {
    now: input.now,
    kind: 'manual',
    businessDate: claimed.businessDate,
    actor: { adminId: claimed.requestedBy, ip: claimed.ip },
    runId: claimed.id,
    ...(input.maxMismatchesPerCheck === undefined
      ? {}
      : { maxMismatchesPerCheck: input.maxMismatchesPerCheck }),
    onRecorded: async (tx, stored) => {
      request = await markDone(tx, stored.run.finishedAt);
    },
  });
  return { ran: true, request, run: detail.run };
}

/**
 * Fails a request whose job will not run again (attempts exhausted). A
 * request already done or failed is left as it is.
 */
export async function failReconciliationRequest(
  db: Database,
  input: { requestId: string; now: Date; error: string },
): Promise<void> {
  if (!UUID_RE.test(input.requestId)) return;
  await db
    .update(reconciliationRequests)
    .set({ status: 'failed', error: input.error.slice(0, 1000), finishedAt: input.now })
    .where(
      and(
        eq(reconciliationRequests.id, input.requestId),
        inArray(reconciliationRequests.status, ['queued', 'running']),
      ),
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

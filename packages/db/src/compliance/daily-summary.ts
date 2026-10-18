import { createHash } from 'node:crypto';
import {
  addBusinessDays,
  businessDateOf,
  businessDatesBetween,
  businessDayWindow,
  canonicalJson,
  classifyPosting,
  DAILY_FIGURE_AMOUNTS,
  DAILY_FIGURE_NUMBERS,
  DAILY_SUMMARY_FINALIZED,
  dailySummaryCsv,
  isBusinessDate,
  JACKPOT_REFUND_KEY_PREFIX,
  REJECTION_KEY_PREFIX,
  summarizeDailyTotals,
  type CategoryTotal,
  type DailyFigures,
  type DailySummaryRow,
} from '@vamos/core';
import { and, asc, desc, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { domainBadRequest, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor, DbTransaction } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { enqueueOutbox } from '../platform/outbox';
import { dailySummaries, dailySummaryVersions } from '../schema/compliance';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../schema/ledger';
import { payouts } from '../schema/payments';
import { loadComplianceSettings } from './settings';

/**
 * The regulator's daily summary (Phase 10). A business day is a calendar
 * day in Addis Ababa (UTC+3, no DST): [D-1 21:00Z, D 21:00Z). Its figures
 * are sums over the ledger postings made in that window, by
 * ledger_transactions.created_at (as the back-office dashboard does): a
 * correction lands on the day it is posted, and the days before keep what
 * was paid then. Definitions are in @vamos/core dailysummary; in short
 * turnover = stakes accepted (bets, net of live rejections, plus jackpot
 * entries), payouts = gross money back to players (won bets, cash-outs,
 * refunds, jackpot prizes, net of correction reversals), GGR = turnover -
 * payouts, ELS commission = floor(GGR x rate) when GGR > 0, else 0.
 *
 * A summary is provisional until finalised: recomputing a provisional day
 * with different figures records a new version (daily_summary_versions);
 * the same figures change nothing. Finalising (the worker, after a grace
 * period once the day is over) freezes it for good and sends it to the ELS
 * stream (outbox compliance.daily_summary_finalized → els queue: a JSONL
 * record and the day's CSV).
 */

export type DailySummary = typeof dailySummaries.$inferSelect;
export type DailySummaryVersion = typeof dailySummaryVersions.$inferSelect;

/** Default wait after the end of a business day before the worker finalises it. */
export const DAILY_SUMMARY_GRACE_MS = 2 * 3_600_000;
/** Most days finalised by one runDailySummaries call. */
export const DAILY_SUMMARY_MAX_DAYS_PER_RUN = 31;

function assertDate(date: string): void {
  if (!isBusinessDate(date)) {
    throw domainBadRequest('invalid_business_date', 'A business date is written YYYY-MM-DD.', {
      date,
    });
  }
}

/** The figures as JSON (santim as decimal strings), in a fixed field order. */
export function figuresToJson(figures: DailyFigures): Record<string, string | number> {
  const json: Record<string, string | number> = {};
  for (const field of DAILY_FIGURE_AMOUNTS) json[field] = figures[field].toString();
  for (const field of DAILY_FIGURE_NUMBERS) json[field] = figures[field];
  return json;
}

/** SHA-256 (hex) of a day's figures: canonical JSON of the date and the figures. */
export function dailyFiguresHash(date: string, figures: DailyFigures): string {
  return createHash('sha256')
    .update(canonicalJson({ businessDate: date, figures: figuresToJson(figures) }))
    .digest('hex');
}

/** The figures stored on a daily summary row. */
export function figuresOf(row: DailySummary): DailyFigures {
  return {
    turnover: row.turnover,
    betStakes: row.betStakes,
    betCount: row.betCount,
    jackpotStakes: row.jackpotStakes,
    jackpotEntryCount: row.jackpotEntryCount,
    payouts: row.payouts,
    wonPayouts: row.wonPayouts,
    cashOuts: row.cashOuts,
    refunds: row.refunds,
    jackpotPrizes: row.jackpotPrizes,
    ggr: row.ggr,
    taxWithheld: row.taxWithheld,
    bonuses: row.bonuses,
    deposits: row.deposits,
    depositCount: row.depositCount,
    withdrawals: row.withdrawals,
    withdrawalCount: row.withdrawalCount,
    activePlayers: row.activePlayers,
    commissionRateBps: row.commissionRateBps,
    commissionDue: row.commissionDue,
  };
}

/** A summary row in the shape of the CSV (and the ELS record). */
export function dailySummaryRowOf(row: DailySummary): DailySummaryRow {
  return {
    ...figuresOf(row),
    businessDate: row.businessDate,
    status: row.status,
    version: row.version,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    hash: row.hash,
  };
}

/**
 * Sums the ledger postings of one business day into category totals
 * (classified like core classifyPosting: rejections and jackpot refunds by
 * key prefix, a settlement reversal by the type of the settlement it
 * negates), plus the active players (a stake, deposit or withdrawal that day).
 */
export async function loadDailyTotals(
  exec: DbExecutor,
  date: string,
): Promise<{ totals: CategoryTotal[]; activePlayers: number }> {
  assertDate(date);
  const { start, end } = businessDayWindow(date);
  const from = start.toISOString();
  const to = end.toISOString();
  const grouped = await exec.execute<{
    type: string;
    key_prefix: string;
    reversed_type: string | null;
    kind: string;
    amount: string;
    transactions: number;
  }>(sql`
    SELECT t.type::text AS type,
      CASE
        WHEN starts_with(t.idempotency_key, ${REJECTION_KEY_PREFIX}) THEN ${REJECTION_KEY_PREFIX}
        WHEN starts_with(t.idempotency_key, ${JACKPOT_REFUND_KEY_PREFIX}) THEN ${JACKPOT_REFUND_KEY_PREFIX}
        ELSE ''
      END AS key_prefix,
      o.type::text AS reversed_type,
      a.kind::text AS kind,
      sum(e.amount)::text AS amount,
      count(DISTINCT t.id)::int AS transactions
    FROM ${ledgerTransactions} t
    JOIN ${ledgerEntries} e ON e.transaction_id = t.id
    JOIN ${ledgerAccounts} a ON a.id = e.account_id
    LEFT JOIN ${ledgerTransactions} o
      ON t.type = 'settlement_reversal'
      AND starts_with(t.idempotency_key, 'reverse:')
      AND o.idempotency_key = 'settle:' || substr(t.idempotency_key, 9)
    WHERE t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz
    GROUP BY 1, 2, 3, 4
  `);
  const totals: CategoryTotal[] = grouped.rows.map((row) => ({
    category: classifyPosting({
      type: row.type,
      idempotencyKey: row.key_prefix,
      reversedType: row.reversed_type,
    }),
    kind: row.kind,
    amount: BigInt(row.amount),
    transactions: Number(row.transactions),
  }));
  // Active: a bet stake, jackpot entry (not a refund), deposit or withdrawal request on the
  // player's cash account that day, or a withdrawal paid that day (no player entry: by its payout).
  const active = await exec.execute<{ n: number }>(sql`
    SELECT count(DISTINCT user_id)::int AS n FROM (
      SELECT a.user_id
      FROM ${ledgerTransactions} t
      JOIN ${ledgerEntries} e ON e.transaction_id = t.id
      JOIN ${ledgerAccounts} a ON a.id = e.account_id
      WHERE t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz
        AND a.kind = 'player_cash'
        AND (t.type IN ('bet_stake', 'deposit', 'withdrawal')
          OR (t.type = 'jackpot_entry' AND NOT starts_with(t.idempotency_key, ${JACKPOT_REFUND_KEY_PREFIX})))
      UNION ALL
      SELECT p.user_id
      FROM ${ledgerTransactions} t
      JOIN ${payouts} p ON p.id::text = t.ref_id
      WHERE t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz
        AND t.type = 'withdrawal' AND t.ref_type = 'payout'
    ) active
  `);
  return { totals, activePlayers: Number(active.rows[0]?.n ?? 0) };
}

/** A business day's figures as the ledger has them now (the commission rate in force unless given). */
export async function computeDailyFigures(
  exec: DbExecutor,
  date: string,
  options: { commissionRateBps?: number } = {},
): Promise<DailyFigures> {
  const commissionRateBps =
    options.commissionRateBps ?? (await loadComplianceSettings(exec)).elsCommission.rateBps;
  const { totals, activePlayers } = await loadDailyTotals(exec, date);
  return summarizeDailyTotals(totals, { activePlayers, commissionRateBps });
}

function figureColumns(figures: DailyFigures) {
  return {
    turnover: figures.turnover,
    betStakes: figures.betStakes,
    betCount: figures.betCount,
    jackpotStakes: figures.jackpotStakes,
    jackpotEntryCount: figures.jackpotEntryCount,
    payouts: figures.payouts,
    wonPayouts: figures.wonPayouts,
    cashOuts: figures.cashOuts,
    refunds: figures.refunds,
    jackpotPrizes: figures.jackpotPrizes,
    ggr: figures.ggr,
    taxWithheld: figures.taxWithheld,
    bonuses: figures.bonuses,
    deposits: figures.deposits,
    depositCount: figures.depositCount,
    withdrawals: figures.withdrawals,
    withdrawalCount: figures.withdrawalCount,
    activePlayers: figures.activePlayers,
    commissionRateBps: figures.commissionRateBps,
    commissionDue: figures.commissionDue,
  };
}

/**
 * - created: the first summary of the day (version 1);
 * - recomputed: provisional, the figures changed (a new version);
 * - unchanged: provisional, same figures (computed_at moves on);
 * - final: already final; nothing was computed or changed.
 */
export type RefreshDailySummaryOutcome = 'created' | 'recomputed' | 'unchanged' | 'final';

export interface RefreshDailySummaryResult {
  summary: DailySummary;
  outcome: RefreshDailySummaryOutcome;
}

/**
 * Computes a business day's summary from the ledger and stores it while it
 * is provisional (in the caller's transaction; the day is serialised by an
 * advisory lock). 422 `summary_not_started` for a day that has not begun at
 * `now`; 400 `invalid_business_date`. `actor` is 'system' or a staff id.
 */
export async function refreshDailySummary(
  tx: DbTransaction,
  input: { date: string; now: Date; actor?: string },
): Promise<RefreshDailySummaryResult> {
  const { date, now } = input;
  assertDate(date);
  const window = businessDayWindow(date);
  if (now.getTime() < window.start.getTime()) {
    throw domainUnprocessable('summary_not_started', 'This business day has not started yet.', {
      date,
    });
  }
  const actor = input.actor ?? 'system';
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vamos:daily_summary:${date}`}))`);
  const [existing] = await tx
    .select()
    .from(dailySummaries)
    .where(eq(dailySummaries.businessDate, date))
    .for('update');
  if (existing?.status === 'final') return { summary: existing, outcome: 'final' };

  const figures = await computeDailyFigures(tx, date);
  const hash = dailyFiguresHash(date, figures);
  if (existing !== undefined && existing.hash === hash) {
    const [row] = await tx
      .update(dailySummaries)
      .set({ computedAt: now })
      .where(eq(dailySummaries.businessDate, date))
      .returning();
    return { summary: row ?? existing, outcome: 'unchanged' };
  }
  const version = (existing?.version ?? 0) + 1;
  const versionRow = {
    businessDate: date,
    version,
    figures: figuresToJson(figures),
    hash,
    reason: existing === undefined ? 'computed' : 'recomputed',
    computedAt: now,
    computedBy: actor,
  };
  let summary: DailySummary | undefined;
  if (existing === undefined) {
    [summary] = await tx
      .insert(dailySummaries)
      .values({
        businessDate: date,
        status: 'provisional',
        version,
        windowStart: window.start,
        windowEnd: window.end,
        ...figureColumns(figures),
        hash,
        computedAt: now,
      })
      .returning();
    await tx.insert(dailySummaryVersions).values(versionRow);
  } else {
    await tx.insert(dailySummaryVersions).values(versionRow);
    [summary] = await tx
      .update(dailySummaries)
      .set({ version, ...figureColumns(figures), hash, computedAt: now })
      .where(eq(dailySummaries.businessDate, date))
      .returning();
  }
  if (summary === undefined) throw new Error(`daily summary ${date} was not stored`);
  return { summary, outcome: existing === undefined ? 'created' : 'recomputed' };
}

export interface FinalizeDailySummaryResult {
  summary: DailySummary;
  /** false when it was final already (nothing written). */
  changed: boolean;
}

/**
 * Recomputes a day one last time and freezes it (`final`), with the outbox
 * event compliance.daily_summary_finalized (the ELS stream's record of the
 * day; the file reporter also writes its CSV) and the audit record
 * `compliance.daily_summary_finalized`. 422 `summary_not_due` before the
 * day's end plus `graceMs` (default 0: a staff action may finalise as soon
 * as the day is over). A final summary is returned as it is.
 */
export async function finalizeDailySummary(
  tx: DbTransaction,
  input: { date: string; now: Date; actor?: string; graceMs?: number; ip?: string | null },
): Promise<FinalizeDailySummaryResult> {
  const { date, now } = input;
  assertDate(date);
  const window = businessDayWindow(date);
  const dueAt = window.end.getTime() + (input.graceMs ?? 0);
  if (now.getTime() < dueAt) {
    throw domainUnprocessable(
      'summary_not_due',
      'This business day can be finalised once it is over (and its grace period has passed).',
      { date, dueAt: new Date(dueAt).toISOString() },
    );
  }
  const actor = input.actor ?? 'system';
  const refreshed = await refreshDailySummary(tx, { date, now, actor });
  if (refreshed.outcome === 'final') return { summary: refreshed.summary, changed: false };
  const [summary] = await tx
    .update(dailySummaries)
    .set({ status: 'final', finalizedAt: now, finalizedBy: actor, computedAt: now })
    .where(eq(dailySummaries.businessDate, date))
    .returning();
  if (summary === undefined) throw new Error(`daily summary ${date} vanished`);
  const payload = {
    businessDate: date,
    version: summary.version,
    windowStart: summary.windowStart,
    windowEnd: summary.windowEnd,
    ...figuresToJson(figuresOf(summary)),
    hash: summary.hash,
  };
  await enqueueOutbox(tx, {
    type: DAILY_SUMMARY_FINALIZED,
    aggregateType: 'daily_summary',
    aggregateId: date,
    payload,
  });
  await writeAudit(tx, {
    actorType: actor === 'system' ? 'system' : 'admin',
    actorId: actor === 'system' ? null : actor,
    action: DAILY_SUMMARY_FINALIZED,
    targetType: 'daily_summary',
    targetId: date,
    metadata: payload,
    ip: input.ip ?? null,
  });
  return { summary, changed: true };
}

/** The business date of the first ledger posting (null for an empty ledger). */
async function firstLedgerDate(exec: DbExecutor): Promise<string | null> {
  const [row] = await exec
    .select({
      ms: sql<
        string | null
      >`(extract(epoch from min(${ledgerTransactions.createdAt})) * 1000)::bigint::text`,
    })
    .from(ledgerTransactions);
  return row?.ms ? businessDateOf(new Date(Number(row.ms))) : null;
}

export interface RunDailySummariesResult {
  /** Days finalised by this run, oldest first. */
  finalized: string[];
  /** Provisional days recomputed (today and days still in their grace period). */
  refreshed: string[];
}

/**
 * The worker's daily summary task: finalises every day that is over (plus
 * `graceMs`, default DAILY_SUMMARY_GRACE_MS) and not final yet, from the
 * first ledger posting on (at most `maxDays` per run, oldest first), then
 * recomputes the provisional summaries of the days not due yet (the days
 * still in their grace period and today). One transaction per day.
 */
export async function runDailySummaries(
  db: Database,
  input: { now: Date; graceMs?: number; maxDays?: number },
): Promise<RunDailySummariesResult> {
  const { now } = input;
  const graceMs = input.graceMs ?? DAILY_SUMMARY_GRACE_MS;
  const maxDays = input.maxDays ?? DAILY_SUMMARY_MAX_DAYS_PER_RUN;
  const first = await firstLedgerDate(db);
  const result: RunDailySummariesResult = { finalized: [], refreshed: [] };
  if (first === null) return result;
  const today = businessDateOf(now);
  // The last day D with end(D) + grace <= now, i.e. start(D + 1) <= now - grace.
  const lastDueDay = addBusinessDays(businessDateOf(new Date(now.getTime() - graceMs)), -1);
  const finals = new Set(
    (
      await db
        .select({ date: dailySummaries.businessDate })
        .from(dailySummaries)
        .where(and(eq(dailySummaries.status, 'final'), gte(dailySummaries.businessDate, first)))
    ).map((row) => row.date),
  );
  if (first <= lastDueDay) {
    for (const date of businessDatesBetween(first, lastDueDay, 100_000)) {
      if (finals.has(date)) continue;
      if (result.finalized.length >= maxDays) break;
      const outcome = await db.transaction((tx) =>
        finalizeDailySummary(tx, { date, now, graceMs }),
      );
      if (outcome.changed) result.finalized.push(date);
    }
  }
  const pendingFrom = first > lastDueDay ? first : addBusinessDays(lastDueDay, 1);
  if (pendingFrom <= today) {
    for (const date of businessDatesBetween(pendingFrom, today, 400)) {
      const outcome = await db.transaction((tx) => refreshDailySummary(tx, { date, now }));
      if (outcome.outcome !== 'final') result.refreshed.push(date);
    }
  }
  return result;
}

/** One summary with every version recorded for it. */
export async function getDailySummary(
  exec: DbExecutor,
  date: string,
): Promise<{ summary: DailySummary; versions: DailySummaryVersion[] }> {
  assertDate(date);
  const [summary] = await exec
    .select()
    .from(dailySummaries)
    .where(eq(dailySummaries.businessDate, date));
  if (summary === undefined) throw domainNotFound('Daily summary');
  const versions = await exec
    .select()
    .from(dailySummaryVersions)
    .where(eq(dailySummaryVersions.businessDate, date))
    .orderBy(asc(dailySummaryVersions.version));
  return { summary, versions };
}

export interface DailySummaryQuery {
  /** Oldest business date shown (inclusive). */
  from?: string;
  /** Newest business date shown (inclusive). */
  to?: string;
  status?: 'provisional' | 'final';
  limit?: number;
  /** The business date after which the page continues (nextCursor of the previous page). */
  cursor?: string;
}

/** Daily summaries, newest first (cursor: the last date of the previous page). */
export async function listDailySummaries(
  exec: DbExecutor,
  query: DailySummaryQuery = {},
): Promise<{ items: DailySummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 31), 1), 366);
  const conditions: SQL[] = [];
  for (const date of [query.from, query.to, query.cursor]) {
    if (date !== undefined) assertDate(date);
  }
  if (query.from !== undefined) conditions.push(gte(dailySummaries.businessDate, query.from));
  if (query.to !== undefined) conditions.push(lte(dailySummaries.businessDate, query.to));
  if (query.cursor !== undefined) conditions.push(lt(dailySummaries.businessDate, query.cursor));
  if (query.status !== undefined) conditions.push(eq(dailySummaries.status, query.status));
  const rows = await exec
    .select()
    .from(dailySummaries)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(dailySummaries.businessDate))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? (items[items.length - 1]?.businessDate ?? null) : null,
  };
}

/**
 * The CSV download of the summaries from `from` to `to` (inclusive, oldest
 * first; at most 366 days): see core DAILY_SUMMARY_CSV_COLUMNS. Amounts are
 * santim.
 */
export async function dailySummariesCsv(
  exec: DbExecutor,
  range: { from: string; to: string },
): Promise<string> {
  assertDate(range.from);
  assertDate(range.to);
  if (range.from > range.to || businessDatesBetween(range.from, range.to, 100_000).length > 366) {
    throw domainUnprocessable(
      'invalid_range',
      'The range must start on or before its end and span at most 366 days.',
    );
  }
  const rows = await exec
    .select()
    .from(dailySummaries)
    .where(
      and(gte(dailySummaries.businessDate, range.from), lte(dailySummaries.businessDate, range.to)),
    )
    .orderBy(asc(dailySummaries.businessDate));
  return dailySummaryCsv(rows.map(dailySummaryRowOf));
}

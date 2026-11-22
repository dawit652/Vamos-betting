import { addBusinessDays, businessDateOf } from '@vamos/core';
import {
  changedReportDays,
  closeReportDay,
  firstLedgerDate,
  lastClosedReportDate,
  REPORT_CLOSE_GRACE_MS,
} from '@vamos/db';
import { sql } from 'drizzle-orm';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { raiseOwnerAlert } from '../lib/owner-alert';
import type { TaskContext } from './context';

/**
 * Closes the owner reports' business days (docs/plans/owner-reports.md). Every pass, after
 * midnight in Addis Ababa (plus REPORT_CLOSE_GRACE_MS), it closes each day not closed yet, oldest
 * first (from the first posting ever, at most REPORT_CLOSE_MAX_DAYS a pass), then checks that the
 * last REPORT_RECHECK_DAYS closed days are unchanged since their close. A failed check is an
 * `error` log line with `alarm: 'report_check_failed'` and an alert to the owner.
 */

const MINUTE = 60_000;
export const REPORT_CLOSE_INTERVAL_MS = 10 * MINUTE;
export const REPORT_CLOSE_MAX_DAYS = 31;
export const REPORT_RECHECK_DAYS = 7;
const REPORT_CLOSE_LOCK = 'owner-report-close';

export interface ReportCloseResult {
  closed: string[];
  /** Days closed this pass whose close-time checks failed. */
  failed: Array<{ date: string; checks: string[] }>;
  /** Closed days whose postings changed since their close. */
  changed: string[];
  skipped?: 'locked';
}

/** The last business day whose close is due at `now` (over, plus the grace). */
export function lastClosableDay(now: Date): string {
  return addBusinessDays(businessDateOf(new Date(now.getTime() - REPORT_CLOSE_GRACE_MS)), -1);
}

export async function runReportClose(ctx: TaskContext): Promise<ReportCloseResult> {
  const now = ctx.clock();
  const last = lastClosableDay(now);
  return ctx.db.transaction(async (lockTx): Promise<ReportCloseResult> => {
    const lock = await lockTx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${REPORT_CLOSE_LOCK})) AS locked`,
    );
    if (lock.rows[0]?.locked !== true) {
      return { closed: [], failed: [], changed: [], skipped: 'locked' };
    }
    const result: ReportCloseResult = { closed: [], failed: [], changed: [] };
    const lastClosed = await lastClosedReportDate(ctx.db);
    let day = lastClosed === null ? await firstLedgerDate(ctx.db) : addBusinessDays(lastClosed, 1);
    for (let i = 0; day !== null && day <= last && i < REPORT_CLOSE_MAX_DAYS; i += 1) {
      const date: string = day;
      const closed = await ctx.db.transaction((tx) => closeReportDay(tx, { date, now }), {
        isolationLevel: 'repeatable read',
      });
      if (closed.closedNow) {
        result.closed.push(date);
        const failed = [
          closed.checks.balanced ? null : 'balanced',
          closed.checks.everyPostingBalanced ? null : 'every_posting_balanced',
          closed.checks.rollForward === false ? 'balances_roll_forward' : null,
        ].filter((check): check is string => check !== null);
        if (failed.length > 0) result.failed.push({ date, checks: failed });
      }
      day = addBusinessDays(date, 1);
    }
    result.changed = await changedReportDays(ctx.db, {
      from: addBusinessDays(last, -(REPORT_RECHECK_DAYS - 1)),
      to: last,
    });
    for (const { date, checks } of result.failed) await alarm(ctx, date, checks);
    for (const date of result.changed) await alarm(ctx, date, ['unchanged_since_close']);
    if (result.closed.length > 0) ctx.logger.info({ closed: result.closed }, 'report days closed');
    return result;
  });
}

async function alarm(ctx: TaskContext, date: string, checks: string[]): Promise<void> {
  ctx.logger.error({ alarm: 'report_check_failed', date, checks }, 'owner report check failed');
  await raiseOwnerAlert(ctx, { alarm: 'report_check_failed', date, checks });
}

export function reportCloseTask(ctx: TaskContext): IntervalTask {
  return intervalTask({
    name: 'report-close',
    intervalMs: REPORT_CLOSE_INTERVAL_MS,
    logger: ctx.logger,
    run: () => runReportClose(ctx),
  });
}

import { sql } from 'drizzle-orm';
import { check, date, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One closed business day of the owner reports (docs/plans/owner-reports.md): what the ledger
 * showed for that day when the day was closed, after midnight in Addis Ababa. A report for any
 * period recomputes its figures from the ledger and compares each closed day with this row, so a
 * day that changed after its close (a back-dated or edited posting) is shown and alarmed, never
 * silently reported.
 */
export const reportDays = pgTable(
  'report_days',
  {
    businessDate: date('business_date').primaryKey(),
    /** The day's ReportTotal rows (core), canonical order, amounts as decimal strings of santim. */
    totals: jsonb('totals').$type<StoredReportTotal[]>().notNull(),
    /** SHA-256 (hex) of the canonical totals: what "unchanged since close" compares. */
    totalsHash: text('totals_hash').notNull(),
    /** Every balance at the end of the day (Σ of all postings before it), by kind and provider. */
    closing: jsonb('closing').$type<Record<string, string>>().notNull(),
    /** The checks run at the close (see closeReportDay). */
    checks: jsonb('checks').$type<StoredReportChecks>().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
  },
  (t) => [check('report_days_hash_hex', sql`${t.totalsHash} ~ '^[0-9a-f]{64}$'`)],
);

export type StoredReportTotal = [
  category: string,
  channel: string,
  kind: string,
  provider: string | null,
  type: string | null,
  amount: string,
  transactions: number,
];

export interface StoredReportChecks {
  /** Σ of the day's postings is 0. */
  balanced: boolean;
  /** No posting of the day is unbalanced on its own. */
  everyPostingBalanced: boolean;
  /** The previous day's closing balances + this day's movements = this day's closing (null: no previous day). */
  rollForward: boolean | null;
}

export type ReportDay = typeof reportDays.$inferSelect;

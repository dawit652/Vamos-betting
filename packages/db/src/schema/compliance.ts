import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';

/**
 * Compliance and regulator reporting (Phase 10). The services are in
 * packages/db/src/compliance, the pure maths in @vamos/core (businessday,
 * dailysummary, els, aml, pspstatement). Kept 7 years (docs/compliance.md);
 * the evidence tables refuse UPDATE/DELETE beyond the transitions their
 * services make (migration 0023_phase10_compliance_guards).
 */

/** pending: recorded, not yet written by the reporter; written: in the stream (final). */
export const elsReportStatus = pgEnum('els_report_status', ['pending', 'written']);

/**
 * One record of the ELS transaction stream per reportable outbox event,
 * recorded before it is written so a replay (a redelivered job, a restart,
 * the sweep) never writes a second line: `line` is the exact canonical JSON
 * written, `hash` its SHA-256. No player names or phone numbers: the record
 * carries the pseudonymous player id (`player_ref`) and santim amounts.
 */
export const elsReports = pgTable(
  'els_reports',
  {
    /** outbox_events.id (no foreign key: the outbox may be purged sooner than the 7-year stream). */
    outboxId: bigint('outbox_id', { mode: 'bigint' }).primaryKey(),
    type: text('type').notNull(),
    /** Business date (Africa/Addis_Ababa) of the event: the stream file it belongs to. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    playerRef: uuid('player_ref'),
    line: text('line').notNull(),
    hash: text('hash').notNull(),
    status: elsReportStatus('status').notNull().default('pending'),
    /** Times a write was started (a retry after an unconfirmed write checks the file first). */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Where it was written (path under ELS_REPORT_DIR). */
    location: text('location'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    writtenAt: timestamp('written_at', { withTimezone: true }),
  },
  (t) => [
    index('els_reports_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('els_reports_date_idx').on(t.businessDate, t.outboxId),
    check('els_reports_written', sql`(${t.status} = 'written') = (${t.writtenAt} IS NOT NULL)`),
    check('els_reports_hash', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    check('els_reports_attempts', sql`${t.attempts} >= 0`),
  ],
);

/** Named positions of the compliance sweeps (e.g. the last outbox id checked for unreported events). */
export const complianceCursors = pgTable('compliance_cursors', {
  name: text('name').primaryKey(),
  position: bigint('position', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** provisional: may still be recomputed (each change is a new version); final: frozen. */
export const dailySummaryStatus = pgEnum('daily_summary_status', ['provisional', 'final']);

/**
 * The regulator's daily summary of one business day (Africa/Addis_Ababa),
 * computed from ledger postings by their time (see @vamos/core
 * dailysummary for the definitions). Santim throughout; payouts gross.
 * Immutable once `final`.
 */
export const dailySummaries = pgTable(
  'daily_summaries',
  {
    businessDate: date('business_date', { mode: 'string' }).primaryKey(),
    status: dailySummaryStatus('status').notNull().default('provisional'),
    version: integer('version').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    turnover: bigint('turnover', { mode: 'bigint' }).notNull(),
    betStakes: bigint('bet_stakes', { mode: 'bigint' }).notNull(),
    betCount: integer('bet_count').notNull(),
    jackpotStakes: bigint('jackpot_stakes', { mode: 'bigint' }).notNull(),
    jackpotEntryCount: integer('jackpot_entry_count').notNull(),
    payouts: bigint('payouts', { mode: 'bigint' }).notNull(),
    wonPayouts: bigint('won_payouts', { mode: 'bigint' }).notNull(),
    cashOuts: bigint('cash_outs', { mode: 'bigint' }).notNull(),
    refunds: bigint('refunds', { mode: 'bigint' }).notNull(),
    jackpotPrizes: bigint('jackpot_prizes', { mode: 'bigint' }).notNull(),
    ggr: bigint('ggr', { mode: 'bigint' }).notNull(),
    taxWithheld: bigint('tax_withheld', { mode: 'bigint' }).notNull(),
    bonuses: bigint('bonuses', { mode: 'bigint' }).notNull(),
    deposits: bigint('deposits', { mode: 'bigint' }).notNull(),
    depositCount: integer('deposit_count').notNull(),
    withdrawals: bigint('withdrawals', { mode: 'bigint' }).notNull(),
    withdrawalCount: integer('withdrawal_count').notNull(),
    activePlayers: integer('active_players').notNull(),
    commissionRateBps: integer('commission_rate_bps').notNull(),
    commissionDue: bigint('commission_due', { mode: 'bigint' }).notNull(),
    /** SHA-256 of the canonical figures (with the date). */
    hash: text('hash').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    /** 'system' or the staff member's id. */
    finalizedBy: text('finalized_by'),
  },
  (t) => [
    index('daily_summaries_status_idx').on(t.status, t.businessDate),
    check('daily_summaries_version', sql`${t.version} >= 1`),
    check(
      'daily_summaries_final',
      sql`(${t.status} = 'final') = (${t.finalizedAt} IS NOT NULL AND ${t.finalizedBy} IS NOT NULL)`,
    ),
    check('daily_summaries_window', sql`${t.windowEnd} = ${t.windowStart} + interval '1 day'`),
    check('daily_summaries_turnover', sql`${t.turnover} = ${t.betStakes} + ${t.jackpotStakes}`),
    check(
      'daily_summaries_payouts',
      sql`${t.payouts} = ${t.wonPayouts} + ${t.cashOuts} + ${t.refunds} + ${t.jackpotPrizes}`,
    ),
    check('daily_summaries_ggr', sql`${t.ggr} = ${t.turnover} - ${t.payouts}`),
    check(
      'daily_summaries_commission',
      sql`${t.commissionRateBps} BETWEEN 0 AND 10000 AND ${t.commissionDue} >= 0 AND (${t.ggr} > 0 OR ${t.commissionDue} = 0) AND ${t.commissionDue} <= GREATEST(${t.ggr}, 0)`,
    ),
    check('daily_summaries_hash', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Every version of a daily summary (append-only): what was computed, when, and by whom. */
export const dailySummaryVersions = pgTable(
  'daily_summary_versions',
  {
    businessDate: date('business_date', { mode: 'string' })
      .notNull()
      .references(() => dailySummaries.businessDate, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    /** DailyFigures, santim as decimal strings. */
    figures: jsonb('figures').notNull(),
    hash: text('hash').notNull(),
    /** 'computed' (first), 'recomputed' (figures changed) or 'finalized'. */
    reason: text('reason').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    /** 'system' or the staff member's id. */
    computedBy: text('computed_by').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.businessDate, t.version] }),
    check('daily_summary_versions_version', sql`${t.version} >= 1`),
  ],
);

export const reconciliationRunKind = pgEnum('reconciliation_run_kind', [
  'scheduled',
  'manual',
  'psp_statement',
]);
export const reconciliationRunStatus = pgEnum('reconciliation_run_status', [
  'clean',
  'mismatches',
  'failed',
]);

/** A PSP statement imported by staff (append-only), with its lines below. */
export const pspStatements = pgTable(
  'psp_statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The providers the statement covers (its lines' providers). */
    providers: text('providers').array().notNull(),
    periodFrom: date('period_from', { mode: 'string' }).notNull(),
    periodTo: date('period_to', { mode: 'string' }).notNull(),
    fileName: text('file_name'),
    /** SHA-256 of the file: the same file is imported once. */
    fileHash: text('file_hash').notNull(),
    lineCount: integer('line_count').notNull(),
    /** Σ positive line amounts (money in) and Σ |negative| ones (money out), santim. */
    totalIn: bigint('total_in', { mode: 'bigint' }).notNull(),
    totalOut: bigint('total_out', { mode: 'bigint' }).notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('psp_statements_file_hash_uq').on(t.fileHash),
    index('psp_statements_uploaded_idx').on(t.uploadedAt, t.id),
    check('psp_statements_period', sql`${t.periodFrom} <= ${t.periodTo}`),
    check('psp_statements_file_hash', sql`${t.fileHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const pspStatementLines = pgTable(
  'psp_statement_lines',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => pspStatements.id, { onDelete: 'restrict' }),
    lineNo: integer('line_no').notNull(),
    provider: text('provider').notNull(),
    reference: text('reference').notNull(),
    /** Santim; negative for money paid out. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** deposit | payout as the statement says, or null. */
    kind: text('kind'),
    /** PspLineStatus (matched, amount_mismatch, status_mismatch, unmatched, ambiguous, duplicate). */
    matchStatus: text('match_status').notNull(),
    recordKind: text('record_kind'),
    recordId: uuid('record_id'),
    recordAmount: bigint('record_amount', { mode: 'bigint' }),
  },
  (t) => [uniqueIndex('psp_statement_lines_line_uq').on(t.statementId, t.lineNo)],
);

/**
 * One reconciliation run (append-only once written): the scheduled daily
 * run, a run staff started, or the matching of an imported PSP statement.
 * `checks` summarises every check (CheckSummary[]); the mismatches found
 * are rows of reconciliation_mismatches.
 */
export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: reconciliationRunKind('kind').notNull(),
    status: reconciliationRunStatus('status').notNull(),
    /** The business day the per-day payment checks covered (null for a statement run). */
    businessDate: date('business_date', { mode: 'string' }),
    statementId: uuid('statement_id').references(() => pspStatements.id, {
      onDelete: 'restrict',
    }),
    /** 'system' or the staff member's id. */
    triggeredBy: text('triggered_by').notNull(),
    /** CheckSummary[] (packages/db/src/compliance/reconciliation.ts). */
    checks: jsonb('checks')
      .$type<Array<{ check: string; ok: boolean; checked: number; mismatches: number }>>()
      .notNull(),
    mismatchCount: integer('mismatch_count').notNull(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('reconciliation_runs_started_idx').on(t.startedAt, t.id),
    index('reconciliation_runs_statement_idx').on(t.statementId),
    check('reconciliation_runs_count', sql`${t.mismatchCount} >= 0`),
    check(
      'reconciliation_runs_status',
      sql`(${t.status} = 'clean') = (${t.mismatchCount} = 0 AND ${t.error} IS NULL)`,
    ),
    check(
      'reconciliation_runs_statement',
      sql`(${t.kind} = 'psp_statement') = (${t.statementId} IS NOT NULL)`,
    ),
  ],
);

/** A difference a reconciliation run found (what was expected, what was there). */
export const reconciliationMismatches = pgTable(
  'reconciliation_mismatches',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconciliationRuns.id, { onDelete: 'restrict' }),
    /** The check (ledger_transactions, ledger_accounts, balance_after, wallet, house_stakes…). */
    check: text('check').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    expected: text('expected'),
    actual: text('actual'),
    details: jsonb('details'),
  },
  (t) => [index('reconciliation_mismatches_run_idx').on(t.runId, t.id)],
);

export const amlFlagStatus = pgEnum('aml_flag_status', [
  'open',
  'reviewed',
  'dismissed',
  'escalated',
]);
export const amlSeverity = pgEnum('aml_severity', ['low', 'medium', 'high']);

/**
 * A player flagged by an AML rule, once per player, rule and window
 * (`window_key`: the business date the rule fired on, or `deposit:<id>`).
 * Compliance staff review it (aml.review): open → reviewed | dismissed |
 * escalated; escalated → reviewed | dismissed. While a high-severity flag
 * is open or escalated the player's withdrawals wait for staff.
 */
export const amlFlags = pgTable(
  'aml_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** AmlRuleCode. */
    rule: text('rule').notNull(),
    severity: amlSeverity('severity').notNull(),
    windowKey: text('window_key').notNull(),
    status: amlFlagStatus('status').notNull().default('open'),
    /** What the rule saw (santim as strings). */
    details: jsonb('details').notNull(),
    /** When the rule fired (the event that broke the threshold). */
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull(),
    /** What evaluated it: 'event', 'sweep' or 'withdrawal'. */
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('aml_flags_user_rule_window_uq').on(t.userId, t.rule, t.windowKey),
    index('aml_flags_status_idx').on(t.status, t.createdAt, t.id),
    index('aml_flags_created_idx').on(t.createdAt, t.id),
    index('aml_flags_user_idx').on(t.userId, t.status),
    check(
      'aml_flags_review',
      sql`(${t.status} = 'open') = (${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL)`,
    ),
  ],
);

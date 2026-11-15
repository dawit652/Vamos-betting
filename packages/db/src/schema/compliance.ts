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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';

/**
 * Compliance (Phase 10): reconciliation, PSP statements and AML flags. The
 * services are in packages/db/src/compliance, the pure maths in @vamos/core
 * (businessday, aml, pspstatement). The evidence tables refuse UPDATE/DELETE
 * beyond the transitions their services make (migration
 * 0023_phase10_compliance_guards).
 */

/** Named positions of the compliance sweeps (e.g. the ledger entry up to which balance_after is verified). */
export const complianceCursors = pgTable('compliance_cursors', {
  name: text('name').primaryKey(),
  position: bigint('position', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    /** PspLineStatus (matched, amount_mismatch, direction_mismatch, status_mismatch, unmatched, ambiguous, duplicate). */
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

export const reconciliationRequestStatus = pgEnum('reconciliation_request_status', [
  'queued',
  'running',
  'done',
  'failed',
]);

/**
 * A reconciliation staff asked for ("Run now", Phase 12): the API answers
 * 202 at once and the worker runs it off the request path (outbox
 * compliance.reconciliation_requested → the `reconciliation` queue). The
 * run it produces has the request's id. At most one request is queued or
 * running at a time (partial unique index in migration
 * 0028_phase12_reconciliation_requests). Unlike the runs, requests change
 * state (queued → running → done | failed).
 */
export const reconciliationRequests = pgTable(
  'reconciliation_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: reconciliationRequestStatus('status').notNull().default('queued'),
    /** The day of the payment checks (default: the day of the request). */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** The staff member's id. */
    requestedBy: text('requested_by').notNull(),
    ip: text('ip'),
    /** Times the worker started it (a crashed worker's job is retried). */
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** The run it produced (the same id), once done. */
    runId: uuid('run_id').references(() => reconciliationRuns.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('reconciliation_requests_requested_idx').on(t.requestedAt, t.id),
    check('reconciliation_requests_done', sql`(${t.status} = 'done') = (${t.runId} IS NOT NULL)`),
    check('reconciliation_requests_run_id', sql`${t.runId} IS NULL OR ${t.runId} = ${t.id}`),
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

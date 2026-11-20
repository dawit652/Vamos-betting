import { z } from 'zod';
import type { StaffPermission } from './admin';
import { IsoDateTime, Santim } from './common';

/**
 * The compliance back office (`/admin/compliance/*`, Phase 10):
 * reconciliation runs, PSP statement uploads, AML flags and the compliance
 * settings. Same wire conventions and staff session as the rest of
 * `/admin/*` (santim as decimal strings; business dates `YYYY-MM-DD` in
 * Addis Ababa time, UTC+3). Each route needs the permission below (401
 * without a staff session, 403 without the permission).
 */
export const COMPLIANCE_ROUTE_PERMISSIONS = {
  'GET /admin/compliance/reconciliation-runs': 'reports.view',
  'GET /admin/compliance/reconciliation-runs/:id': 'reports.view',
  'POST /admin/compliance/reconciliation-runs': 'reconciliation.run',
  'GET /admin/compliance/reconciliation-requests/:id': 'reports.view',
  'GET /admin/compliance/psp-statements': 'reports.view',
  'GET /admin/compliance/psp-statements/:id': 'reports.view',
  'POST /admin/compliance/psp-statements': 'reconciliation.run',
  'GET /admin/compliance/aml-flags': 'aml.review',
  'GET /admin/compliance/aml-flags/:id': 'aml.review',
  'POST /admin/compliance/aml-flags/:id/review': 'aml.review',
  'GET /admin/compliance/settings': 'reports.view',
  'PUT /admin/compliance/settings/:key': 'settings.edit',
} as const satisfies Record<string, StaffPermission>;
export type ComplianceRoute = keyof typeof COMPLIANCE_ROUTE_PERMISSIONS;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date `YYYY-MM-DD` (a business day in Addis Ababa). */
export const BusinessDate = z.string().refine((value) => {
  const match = DATE_RE.exec(value);
  if (match === null) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d) &&
    Number(y) >= 1970
  );
}, 'expected a date written YYYY-MM-DD');
export type BusinessDate = z.infer<typeof BusinessDate>;

const Uuid = z.uuid();
const Cursor = z.string().min(1).max(200).optional();
const Count = z.number().int();
const Bps = z.number().int().min(0).max(10_000);

function pageLimit(max: number, fallback: number) {
  return z.coerce.number().int().min(1).max(max).default(fallback);
}

function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** `status=open,escalated` or repeated `status=open&status=escalated`. */
function queryList<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
        : value,
    z.array(item).max(20),
  );
}

// ---------------------------------------------------------------------------
// Reconciliation (reports.view; run: reconciliation.run).

export const RECONCILIATION_CHECK_NAMES = [
  'ledger_transactions',
  'ledger_accounts',
  'balance_after',
  'wallet',
  'house_stakes',
  'house_jackpot',
  'house_withdrawals_pending',
  'retail_payable',
  'retail_cash',
  'psp_movements',
  'psp_records',
  'psp_daily_totals',
  'sms_credits',
  'agent_cash_records',
  /** Checked by runs before the daily summaries were removed; kept so their records still read. */
  'daily_summary',
  'psp_statement',
] as const;
export const ReconciliationCheckSchema = z.enum(RECONCILIATION_CHECK_NAMES);
export const ReconciliationRunKindSchema = z.enum(['scheduled', 'manual', 'psp_statement']);
export const ReconciliationRunStatusSchema = z.enum(['clean', 'mismatches', 'failed']);

export const CheckSummaryView = z.object({
  check: ReconciliationCheckSchema,
  ok: z.boolean(),
  checked: Count,
  mismatches: Count,
});
export type CheckSummaryView = z.infer<typeof CheckSummaryView>;

export const ReconciliationRunView = z.object({
  id: z.string(),
  kind: ReconciliationRunKindSchema,
  status: ReconciliationRunStatusSchema,
  businessDate: BusinessDate.nullable(),
  statementId: z.string().nullable(),
  /** 'system' or a staff id. */
  triggeredBy: z.string(),
  checks: z.array(CheckSummaryView),
  mismatchCount: Count,
  error: z.string().nullable(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
});
export type ReconciliationRunView = z.infer<typeof ReconciliationRunView>;

export const ReconciliationMismatchView = z.object({
  id: z.string(),
  check: ReconciliationCheckSchema,
  /** ledger_transaction, ledger_account, ledger_entry, player, payment_intent, payout, psp_provider_day, daily_summary, psp_statement_line. */
  subjectType: z.string(),
  subjectId: z.string(),
  expected: z.string().nullable(),
  actual: z.string().nullable(),
  details: z.unknown(),
});
export type ReconciliationMismatchView = z.infer<typeof ReconciliationMismatchView>;

/** GET /admin/compliance/reconciliation-runs: newest first; `cursor` is the last run's id. */
export const ReconciliationRunQuery = z.object({
  kind: ReconciliationRunKindSchema.optional(),
  status: ReconciliationRunStatusSchema.optional(),
  limit: pageLimit(200, 50),
  cursor: Cursor,
});
export type ReconciliationRunQuery = z.infer<typeof ReconciliationRunQuery>;

export const ReconciliationRunListResponse = page(ReconciliationRunView);
export type ReconciliationRunListResponse = z.infer<typeof ReconciliationRunListResponse>;

/** GET /admin/compliance/reconciliation-runs/:id. */
export const ReconciliationRunDetailResponse = z.object({
  run: ReconciliationRunView,
  mismatches: z.array(ReconciliationMismatchView),
});
export type ReconciliationRunDetailResponse = z.infer<typeof ReconciliationRunDetailResponse>;

/** POST /admin/compliance/reconciliation-runs (run now): the payment checks' day, default today. */
export const RunReconciliationRequest = z.object({ businessDate: BusinessDate.optional() });
export type RunReconciliationRequest = z.infer<typeof RunReconciliationRequest>;

/** queued → running → done (the run exists) | failed. */
export const ReconciliationRequestStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);

/**
 * A "Run now" request: the worker runs it off the request path; the run it
 * produces has the same id (`runId` once done).
 */
export const ReconciliationRequestView = z.object({
  id: z.string(),
  status: ReconciliationRequestStatusSchema,
  businessDate: BusinessDate,
  requestedBy: z.string(),
  attempts: Count,
  error: z.string().nullable(),
  requestedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  runId: z.string().nullable(),
});
export type ReconciliationRequestView = z.infer<typeof ReconciliationRequestView>;

/**
 * The answer of POST /admin/compliance/reconciliation-runs (202 Accepted,
 * Location: the request) and of GET /admin/compliance/reconciliation-requests/:id,
 * which the back office polls until `done` (then it opens the run) or `failed`.
 * 409 `reconciliation_running` while another request is queued or running.
 */
export const ReconciliationRequestResponse = z.object({ request: ReconciliationRequestView });
export type ReconciliationRequestResponse = z.infer<typeof ReconciliationRequestResponse>;

// ---------------------------------------------------------------------------
// PSP statements (reports.view; upload: reconciliation.run).

/**
 * POST /admin/compliance/psp-statements: the statement CSV as text
 * (columns provider, reference, amount in birr, date YYYY-MM-DD or ISO
 * time, optional type deposit|payout; negative amounts are money out). 422
 * `invalid_statement` (details { errors: [{ lineNo, message }] }) when a
 * line cannot be read; 409 `statement_already_imported` (details
 * { statementId }) for the same file twice.
 */
export const ImportPspStatementRequest = z.object({
  csv: z.string().min(1).max(5_000_000),
  fileName: z.string().trim().max(200).optional(),
  /** Every line must be of this provider. */
  provider: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{2,32}$/)
    .optional(),
  /** Defaults to the lines' first and last dates (at most 92 days). */
  periodFrom: BusinessDate.optional(),
  periodTo: BusinessDate.optional(),
});
export type ImportPspStatementRequest = z.infer<typeof ImportPspStatementRequest>;

export const PspLineStatusSchema = z.enum([
  'matched',
  'amount_mismatch',
  'direction_mismatch',
  'status_mismatch',
  'unmatched',
  'ambiguous',
  'duplicate',
]);

export const PspStatementView = z.object({
  id: z.string(),
  providers: z.array(z.string()),
  periodFrom: BusinessDate,
  periodTo: BusinessDate,
  fileName: z.string().nullable(),
  fileHash: z.string(),
  lineCount: Count,
  /** Σ positive line amounts (money in) and Σ of the negative ones (money out), santim. */
  totalIn: Santim,
  totalOut: Santim,
  uploadedBy: z.string(),
  uploadedAt: IsoDateTime,
  /** The matching run, its status and its differences. */
  runId: z.string().nullable(),
  status: ReconciliationRunStatusSchema.nullable(),
  mismatchCount: Count.nullable(),
});
export type PspStatementView = z.infer<typeof PspStatementView>;

export const PspStatementLineView = z.object({
  lineNo: Count,
  provider: z.string(),
  reference: z.string(),
  amount: Santim,
  businessDate: BusinessDate,
  kind: z.enum(['deposit', 'payout']).nullable(),
  matchStatus: PspLineStatusSchema,
  recordKind: z.enum(['deposit', 'payout']).nullable(),
  recordId: z.string().nullable(),
  recordAmount: Santim.nullable(),
});
export type PspStatementLineView = z.infer<typeof PspStatementLineView>;

export const ImportPspStatementResponse = z.object({
  statement: PspStatementView,
  lines: z.array(PspStatementLineView),
  run: ReconciliationRunView,
  mismatches: z.array(ReconciliationMismatchView),
});
export type ImportPspStatementResponse = z.infer<typeof ImportPspStatementResponse>;

/** GET /admin/compliance/psp-statements: newest first; `cursor` is the last statement's id. */
export const PspStatementQuery = z.object({
  provider: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{2,32}$/)
    .optional(),
  limit: pageLimit(200, 50),
  cursor: Cursor,
});
export type PspStatementQuery = z.infer<typeof PspStatementQuery>;

export const PspStatementListResponse = page(PspStatementView);
export type PspStatementListResponse = z.infer<typeof PspStatementListResponse>;

export const PspStatementDetailResponse = z.object({
  statement: PspStatementView,
  lines: z.array(PspStatementLineView),
});
export type PspStatementDetailResponse = z.infer<typeof PspStatementDetailResponse>;

// ---------------------------------------------------------------------------
// AML flags (aml.review).

export const AML_RULE_NAMES = [
  'deposit_velocity',
  'withdrawal_velocity',
  'structuring',
  'deposit_then_withdraw',
  'cashout_churn',
] as const;
export const AmlRuleSchema = z.enum(AML_RULE_NAMES);
export const AmlSeveritySchema = z.enum(['low', 'medium', 'high']);
export const AmlFlagStatusSchema = z.enum(['open', 'reviewed', 'dismissed', 'escalated']);
export type AmlFlagStatus = z.infer<typeof AmlFlagStatusSchema>;

export const AmlFlagView = z.object({
  id: z.string(),
  userId: z.string(),
  rule: AmlRuleSchema,
  severity: AmlSeveritySchema,
  /** The dedupe window: a business date, or deposit:<intent id>. */
  windowKey: z.string(),
  status: AmlFlagStatusSchema,
  /** What the rule saw (santim as strings). */
  details: z.record(z.string(), z.unknown()),
  triggeredAt: IsoDateTime,
  source: z.enum(['event', 'sweep', 'withdrawal']),
  createdAt: IsoDateTime,
  reviewedBy: z.string().nullable(),
  reviewedAt: IsoDateTime.nullable(),
  reviewNote: z.string().nullable(),
  updatedAt: IsoDateTime,
});
export type AmlFlagView = z.infer<typeof AmlFlagView>;

/** GET /admin/compliance/aml-flags: newest first; `cursor` is the last flag's id. */
export const AmlFlagQuery = z.object({
  status: queryList(AmlFlagStatusSchema).optional(),
  rule: AmlRuleSchema.optional(),
  severity: AmlSeveritySchema.optional(),
  userId: Uuid.optional(),
  limit: pageLimit(200, 50),
  cursor: Cursor,
});
export type AmlFlagQuery = z.infer<typeof AmlFlagQuery>;

export const AmlFlagListResponse = page(AmlFlagView);
export type AmlFlagListResponse = z.infer<typeof AmlFlagListResponse>;

/** GET /admin/compliance/aml-flags/:id: the flag, the player's other flags and held withdrawals. */
export const AmlFlagDetailResponse = z.object({
  flag: AmlFlagView,
  otherFlags: z.array(AmlFlagView),
  /** Withdrawals of the player waiting for staff because of an AML flag (payout ids). */
  heldWithdrawals: z.array(z.string()),
});
export type AmlFlagDetailResponse = z.infer<typeof AmlFlagDetailResponse>;

/**
 * POST /admin/compliance/aml-flags/:id/review: open → reviewed | dismissed
 * | escalated; escalated → reviewed | dismissed. The same decision again
 * answers `changed: false`; 409 `aml_flag_closed` once reviewed or
 * dismissed. Audited with the note.
 */
export const ReviewAmlFlagRequest = z.object({
  decision: z.enum(['reviewed', 'dismissed', 'escalated']),
  note: z.string().trim().min(1).max(2000),
});
export type ReviewAmlFlagRequest = z.infer<typeof ReviewAmlFlagRequest>;

export const ReviewAmlFlagResponse = z.object({ flag: AmlFlagView, changed: z.boolean() });
export type ReviewAmlFlagResponse = z.infer<typeof ReviewAmlFlagResponse>;

// ---------------------------------------------------------------------------
// Compliance settings (GET: reports.view; PUT: settings.edit).

const NonNegativeSantimText = Santim.refine((value) => /^\d+$/.test(value), {
  message: 'must not be negative',
});
const PositiveSantimText = Santim.refine((value) => /^[1-9]\d*$/.test(value), {
  message: 'must be a positive amount of santim',
});
const Hours = z
  .number()
  .int()
  .min(1)
  .max(24 * 31);

const AmlVelocityView = z
  .object({
    enabled: z.boolean(),
    severity: AmlSeveritySchema,
    maxPerHour: z.number().int().min(0).max(1_000_000),
    maxPerDay: z.number().int().min(0).max(1_000_000),
  })
  .refine((rule) => rule.maxPerHour <= rule.maxPerDay, {
    message: 'maxPerHour must not exceed maxPerDay',
  });

/** The `aml_rules` setting (placeholders to confirm with counsel). */
export const AmlRulesView = z.object({
  enabled: z.boolean(),
  /** Withdrawals of a player with an open or escalated high-severity flag wait for staff. */
  holdWithdrawalsOnHighSeverity: z.boolean(),
  depositVelocity: AmlVelocityView,
  withdrawalVelocity: AmlVelocityView,
  structuring: z.object({
    enabled: z.boolean(),
    severity: AmlSeveritySchema,
    reportingThreshold: PositiveSantimText,
    nearThresholdBps: Bps,
    minNearCount: z.number().int().min(1).max(1_000),
    windowHours: Hours,
  }),
  depositThenWithdraw: z.object({
    enabled: z.boolean(),
    severity: AmlSeveritySchema,
    minStakeShareBps: Bps,
    minDeposit: NonNegativeSantimText,
  }),
  cashOutChurn: z.object({
    enabled: z.boolean(),
    severity: AmlSeveritySchema,
    windowHours: Hours,
    minCount: z.number().int().min(1).max(1_000),
    maxMinutesAfterPlacement: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
  }),
});
export type AmlRulesView = z.infer<typeof AmlRulesView>;

export const ComplianceSettingKeySchema = z.enum(['aml_rules']);
export type ComplianceSettingKey = z.infer<typeof ComplianceSettingKeySchema>;

/** The value of PUT /admin/compliance/settings/:key (body { value }, like PUT /admin/settings/:key). */
export const COMPLIANCE_SETTING_VALUE_SCHEMAS = {
  aml_rules: AmlRulesView,
} as const satisfies Record<ComplianceSettingKey, z.ZodType>;

/** GET /admin/compliance/settings, and the answer of PUT /admin/compliance/settings/:key. */
export const ComplianceSettingsResponse = z.object({
  settings: z.object({ amlRules: AmlRulesView }),
  changes: z.array(
    z.object({ key: z.string(), updatedAt: IsoDateTime, updatedBy: z.string().nullable() }),
  ),
});
export type ComplianceSettingsResponse = z.infer<typeof ComplianceSettingsResponse>;

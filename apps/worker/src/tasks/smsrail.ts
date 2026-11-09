import {
  RECEIPT_VERIFIABLE_INSTITUTIONS,
  reconcileBalances,
  type BalanceReconciliation,
} from '@vamos/core';
import {
  listBalanceInstitutions,
  listBalanceObservations,
  listSmsDueForReceiptCheck,
  recordReceiptCheck,
  smsRailHealth,
  type ReceiptCheckStatus,
} from '@vamos/db';
import { SmsRailProvider } from '@vamos/payments';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { withTxRetry } from '../lib/retry';
import type { TaskContext } from './context';

/**
 * The SMS rail's independent checks (ported from Melabingo), live rail only:
 * - receipt audit: every credited telebirr SMS is checked against Ethio
 *   Telecom's own receipt page; a contradiction is a receipt alarm at the top
 *   of the review queue (the credit is never reversed automatically);
 * - balance reconciliation: the balance each SMS reports must move by exactly
 *   what the messages say (the only check for CBE, whose receipt page is
 *   unreachable); drift is logged as an alarm and kept for the health panel;
 * - the watch: no SMS from the handset for a while during active hours, a
 *   growing review queue, a manual payout waiting too long.
 * Alarms are `error` log lines with `alarm` set, for the log-based alerts.
 */

export const RECEIPT_AUDIT_INTERVAL_MS = 30_000;
export const BALANCE_RECONCILE_INTERVAL_MS = 60 * 60_000;
export const SMS_RAIL_WATCH_INTERVAL_MS = 5 * 60_000;
/** The window the balance reconciliation sums over. */
export const BALANCE_WINDOW_MS = 24 * 60 * 60_000;
/** Redis key prefix of the last balance reconciliation per institution (read by the API). */
export const BALANCE_RESULT_KEY = 'sms-rail:balance:';

/** The task context (its `receipts` is the verifier of RECEIPT_VERIFY=audit). */
export type SmsRailTaskContext = TaskContext;

function smsProvider(ctx: TaskContext): SmsRailProvider | null {
  const provider = ctx.payments.get('sms');
  return provider instanceof SmsRailProvider ? provider : null;
}

export interface ReceiptAuditSummary {
  checked: number;
  outcomes: Partial<Record<ReceiptCheckStatus, number>>;
}

/** One round of the receipt audit: up to `limit` credited messages not yet checked. */
export async function runReceiptAudit(
  ctx: SmsRailTaskContext,
  options: { limit?: number } = {},
): Promise<ReceiptAuditSummary> {
  const summary: ReceiptAuditSummary = { checked: 0, outcomes: {} };
  const provider = smsProvider(ctx);
  const verifier = ctx.receipts;
  if (provider === null || provider.mode !== 'live' || verifier === undefined) return summary;
  const institutions = RECEIPT_VERIFIABLE_INSTITUTIONS.map((spec) => spec.id).filter(
    (id) => provider.collectionAccountsAt(id).length > 0,
  );
  const due = await listSmsDueForReceiptCheck(ctx.db, { institutions, limit: options.limit ?? 20 });
  for (const sms of due) {
    if (sms.institution === null || sms.reference === null || sms.amount === null) continue;
    const verdict = await verifier.verify({
      institution: sms.institution,
      reference: sms.reference,
      receiverAccounts: provider.collectionAccountsAt(sms.institution),
      amount: sms.amount,
    });
    const status: ReceiptCheckStatus = verdict.status;
    const reason = verdict.status === 'verified' ? null : verdict.reason;
    const facts =
      verdict.status === 'verified' || verdict.status === 'rejected' ? verdict.facts : null;
    const raw =
      verdict.status === 'rejected' || verdict.status === 'indeterminate'
        ? verdict.rawSample
        : null;
    await withTxRetry(ctx.db, (tx) =>
      recordReceiptCheck(tx, {
        smsId: sms.id,
        status,
        reason,
        receiver: facts?.receiverAccount ?? null,
        payer: facts?.payerName ?? null,
        raw,
        now: ctx.clock(),
      }),
    );
    summary.checked += 1;
    summary.outcomes[status] = (summary.outcomes[status] ?? 0) + 1;
    if (status === 'rejected') {
      ctx.logger.error(
        {
          alarm: 'sms_receipt_rejected',
          smsId: sms.id,
          reference: sms.reference,
          amount: sms.amount.toString(),
          reason,
          matchedIntentId: sms.matchedIntentId,
        },
        'a credited SMS is contradicted by the institution’s receipt',
      );
    }
    // The breaker is open: the rest would only answer breaker_open.
    if (verdict.status === 'indeterminate' && verdict.reason === 'breaker_open') break;
  }
  return summary;
}

export interface StoredBalanceResult {
  institution: string;
  checkedAt: string;
  result: BalanceReconciliation;
}

/** One balance reconciliation over the last BALANCE_WINDOW_MS, per institution. */
export async function runBalanceReconciliation(ctx: TaskContext): Promise<StoredBalanceResult[]> {
  const provider = smsProvider(ctx);
  if (provider === null || provider.mode !== 'live') return [];
  const until = ctx.clock();
  const since = new Date(until.getTime() - BALANCE_WINDOW_MS);
  const results: StoredBalanceResult[] = [];
  for (const institution of await listBalanceInstitutions(ctx.db, { since })) {
    const observations = await listBalanceObservations(ctx.db, { institution, since, until });
    const result = reconcileBalances(observations);
    const stored: StoredBalanceResult = { institution, checkedAt: until.toISOString(), result };
    results.push(stored);
    await ctx.redis.set(
      `${BALANCE_RESULT_KEY}${institution}`,
      JSON.stringify(stored, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
      'EX',
      Math.ceil((BALANCE_RECONCILE_INTERVAL_MS * 3) / 1000),
    );
    if (result.status === 'drift') {
      ctx.logger.error(
        {
          alarm: 'sms_balance_drift',
          institution,
          direction: result.direction,
          drift: result.drift.toString(),
          expected: result.expected.toString(),
          actual: result.actual.toString(),
          observations: result.observations,
        },
        result.direction === 'credited_more_than_arrived'
          ? 'collection account balance moved less than we credited: a forged SMS?'
          : 'collection account balance moved more than we saw: SMS went missing',
      );
    }
  }
  return results;
}

/** Hours (EAT) during which silence from the collection handset is an alarm. */
const ACTIVE_FROM_HOUR_EAT = 6;
const SILENCE_ALARM_MS = 30 * 60_000;
const REVIEW_BACKLOG_ALARM = 10;
const REVIEW_AGE_ALARM_MS = 15 * 60_000;
const MANUAL_PAYOUT_AGE_ALARM_MS = 2 * 60 * 60_000;

export interface SmsRailWatchFindings {
  silent: boolean;
  reviewBacklog: boolean;
  slowPayouts: boolean;
}

/** The watch: logs an alarm for each condition that needs a person. */
export async function runSmsRailWatch(ctx: TaskContext): Promise<SmsRailWatchFindings> {
  const findings: SmsRailWatchFindings = {
    silent: false,
    reviewBacklog: false,
    slowPayouts: false,
  };
  const provider = smsProvider(ctx);
  if (provider === null) return findings;
  const now = ctx.clock();
  const health = await smsRailHealth(ctx.db);
  const eatHour = (now.getUTCHours() + 3) % 24;
  if (provider.mode === 'live' && eatHour >= ACTIVE_FROM_HOUR_EAT) {
    const last = health.lastGatewaySmsAt;
    if (last === null || now.getTime() - last.getTime() > SILENCE_ALARM_MS) {
      findings.silent = true;
      ctx.logger.error(
        { alarm: 'sms_gateway_silent', lastGatewaySmsAt: last?.toISOString() ?? null },
        'no SMS from the collection handset for 30 minutes during active hours',
      );
    }
  }
  if (
    health.reviewQueue > REVIEW_BACKLOG_ALARM ||
    (health.oldestReviewAt !== null &&
      now.getTime() - health.oldestReviewAt.getTime() > REVIEW_AGE_ALARM_MS)
  ) {
    findings.reviewBacklog = true;
    ctx.logger.error(
      {
        alarm: 'sms_review_backlog',
        reviewQueue: health.reviewQueue,
        oldestReviewAt: health.oldestReviewAt?.toISOString() ?? null,
        receiptAlarms: health.receiptAlarms,
      },
      'SMS waiting for a person: players may be waiting on deposits',
    );
  }
  if (
    health.oldestManualPayoutApprovedAt !== null &&
    now.getTime() - health.oldestManualPayoutApprovedAt.getTime() > MANUAL_PAYOUT_AGE_ALARM_MS
  ) {
    findings.slowPayouts = true;
    ctx.logger.error(
      {
        alarm: 'manual_payout_waiting',
        open: health.manualPayoutsOpen,
        oldestApprovedAt: health.oldestManualPayoutApprovedAt.toISOString(),
      },
      'an approved manual payout has waited more than 2 hours',
    );
  }
  return findings;
}

export interface SmsRailTaskOptions {
  receiptAuditIntervalMs?: number;
  balanceIntervalMs?: number;
  watchIntervalMs?: number;
}

/** The SMS rail's tasks (none unless `sms` is enabled). */
export function smsRailTasks(
  ctx: SmsRailTaskContext,
  options: SmsRailTaskOptions = {},
): IntervalTask[] {
  if (smsProvider(ctx) === null) return [];
  return [
    intervalTask({
      name: 'sms-receipt-audit',
      intervalMs: options.receiptAuditIntervalMs ?? RECEIPT_AUDIT_INTERVAL_MS,
      logger: ctx.logger,
      run: () => runReceiptAudit(ctx),
    }),
    intervalTask({
      name: 'sms-balance-reconcile',
      intervalMs: options.balanceIntervalMs ?? BALANCE_RECONCILE_INTERVAL_MS,
      logger: ctx.logger,
      run: () => runBalanceReconciliation(ctx),
    }),
    intervalTask({
      name: 'sms-rail-watch',
      intervalMs: options.watchIntervalMs ?? SMS_RAIL_WATCH_INTERVAL_MS,
      logger: ctx.logger,
      run: () => runSmsRailWatch(ctx),
    }),
  ];
}

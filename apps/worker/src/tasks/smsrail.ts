import {
  DEFAULT_FLOAT_FORECAST_RULES,
  RECEIPT_VERIFIABLE_INSTITUTIONS,
  floatIsLow,
  reconcileBalances,
  type BalanceReconciliation,
} from '@vamos/core';
import {
  listBalanceInstitutions,
  listBalanceObservations,
  listIdleManualClaims,
  loadFloatForecast,
  listSmsDueForReceiptCheck,
  recordReceiptCheck,
  smsRailHealth,
  listSilentCollectionAccounts,
  type ReceiptCheckStatus,
} from '@vamos/db';
import { SmsRailProvider } from '@vamos/payments';
import { intervalTask, type IntervalTask } from '../lib/interval';
import { claimAlertSlot, raiseOwnerAlert } from '../lib/owner-alert';
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
 *   growing review queue, a manual payout waiting too long, and the payout float: a collection
 *   account whose last known balance is below the withdrawals the open bets are expected to cause.
 * Alarms are `error` log lines with `alarm` set, for the log-based alerts; each also raises an
 * owner alert (an `owner.alert` outbox row, plan task 1.11) when OWNER_ALERT_PHONES is set.
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
      await raiseOwnerAlert(ctx, { alarm: 'sms_receipt_rejected', smsId: sms.id });
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
      await raiseOwnerAlert(ctx, {
        alarm: 'sms_balance_drift',
        institution,
        direction: result.direction,
      });
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
/** A claimed payout with no settle, release or fail for this long is idle; its alarm repeats at this pace. */
const MANUAL_PAYOUT_CLAIM_IDLE_MS = 30 * 60_000;

/** The sms_account_silent line repeats at this pace while the account stays silent. */
const ACCOUNT_SILENCE_ALARM_REPEAT_MS = 30 * 60_000;

/** The payout_float_low line repeats at this pace while the balance stays below the forecast. */
const PAYOUT_FLOAT_ALARM_REPEAT_MS = 30 * 60_000;

export interface SmsRailWatchFindings {
  silent: boolean;
  /** Collection accounts with waiting deposits and no message from their handset for 30 minutes. */
  silentAccounts: string[];
  reviewBacklog: boolean;
  slowPayouts: boolean;
  /** Ids of claimed payouts idle for over 30 minutes. */
  idleClaims: string[];
  /** Institutions whose last known balance is below the float forecast. */
  floatLow: string[];
}

/** The watch: logs an alarm for each condition that needs a person. */
export async function runSmsRailWatch(ctx: TaskContext): Promise<SmsRailWatchFindings> {
  const findings: SmsRailWatchFindings = {
    silent: false,
    silentAccounts: [],
    reviewBacklog: false,
    slowPayouts: false,
    idleClaims: [],
    floatLow: [],
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
      await raiseOwnerAlert(ctx, { alarm: 'sms_gateway_silent' });
    }
    // One account's handset can be dead while the others still forward: the global silence above
    // would never see it. Only an account with players waiting on it counts (a quiet one is fine).
    const silentAccounts = await listSilentCollectionAccounts(ctx.db, {
      accounts: provider.collectionAccountIds,
      now,
      silenceMs: SILENCE_ALARM_MS,
    });
    for (const silent of silentAccounts) {
      findings.silentAccounts.push(silent.account);
      const first = await claimAlertSlot(
        ctx.redis,
        'raised',
        `log|sms_account_silent|${silent.account}`,
        now.getTime(),
        ACCOUNT_SILENCE_ALARM_REPEAT_MS,
      ).catch(() => true);
      if (!first) continue;
      ctx.logger.error(
        {
          alarm: 'sms_account_silent',
          account: silent.account,
          lastGatewaySmsAt: silent.lastGatewaySmsAt?.toISOString() ?? null,
          waitingDeposits: silent.waitingDeposits,
        },
        'no SMS from this collection account’s handset for 30 minutes while players wait on deposits to it',
      );
      await raiseOwnerAlert(ctx, { alarm: 'sms_account_silent', account: silent.account });
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
    await raiseOwnerAlert(ctx, { alarm: 'sms_review_backlog' });
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
    await raiseOwnerAlert(ctx, { alarm: 'manual_payout_waiting' });
  }
  const idle = await listIdleManualClaims(ctx.db, {
    claimedBefore: new Date(now.getTime() - MANUAL_PAYOUT_CLAIM_IDLE_MS),
  });
  for (const claim of idle) {
    findings.idleClaims.push(claim.id);
    // The watch runs every few minutes: one line per payout per 30 minutes. If Redis is
    // down the line is logged every pass, which is noisier but never silent.
    const first = await claimAlertSlot(
      ctx.redis,
      'raised',
      `log|manual_payout_claim_idle|${claim.id}`,
      now.getTime(),
      MANUAL_PAYOUT_CLAIM_IDLE_MS,
    ).catch(() => true);
    if (!first) continue;
    ctx.logger.error(
      {
        alarm: 'manual_payout_claim_idle',
        payoutId: claim.id,
        heldBy: claim.payingBy,
        claimedAt: claim.processingAt.toISOString(),
      },
      'a claimed manual payout has had no settle, release or fail for more than 30 minutes',
    );
    await raiseOwnerAlert(ctx, { alarm: 'manual_payout_claim_idle' });
  }
  // The payout float: only on the live rail (the simulator's balances are made up). One line per
  // institution per 30 minutes while it stays low.
  if (provider.mode === 'live') {
    const rules = ctx.floatForecast ?? DEFAULT_FLOAT_FORECAST_RULES;
    const { forecast, balances } = await loadFloatForecast(ctx.db, { now, rules });
    const collecting = new Set(provider.collectionAccounts.map((a) => a.institution));
    for (const last of balances) {
      if (!collecting.has(last.institution) || !floatIsLow(last.balance, forecast)) continue;
      findings.floatLow.push(last.institution);
      const first = await claimAlertSlot(
        ctx.redis,
        'raised',
        `log|payout_float_low|${last.institution}`,
        now.getTime(),
        PAYOUT_FLOAT_ALARM_REPEAT_MS,
      ).catch(() => true);
      if (!first) continue;
      ctx.logger.error(
        {
          alarm: 'payout_float_low',
          institution: last.institution,
          balance: last.balance.toString(),
          balanceAt: last.at.toISOString(),
          expectedWithdrawals: forecast.expectedWithdrawals.toString(),
          possiblePayouts: forecast.possiblePayouts.toString(),
          betsCounted: forecast.betsCounted,
          horizonMs: rules.horizonMs,
        },
        'a collection account’s last known balance is below the withdrawals the open bets are expected to cause',
      );
      await raiseOwnerAlert(ctx, { alarm: 'payout_float_low', institution: last.institution });
    }
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

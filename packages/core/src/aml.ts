import { businessDateOf } from './businessday';
import { birr, BPS_DENOMINATOR, type Santim } from './money';

/**
 * Anti-money-laundering rules (pure). A rule looks at one player's recent
 * money movements and returns a hit; the database turns a hit into an
 * `aml_flags` row for compliance staff, once per player, rule and window
 * (the hit's `windowKey`). Thresholds are a business setting (`aml_rules`);
 * the defaults below are placeholders to confirm with counsel and the
 * Financial Intelligence Service's reporting rules.
 *
 * Rolling windows: a window of length W ending at instant t holds the
 * events in (t - W, t]. A time-window rule fires at the earliest event
 * time t whose window breaks the threshold; its windowKey is the business
 * date of t, so evaluating again later (another deposit in the same burst,
 * the daily sweep) finds the same t and the same key.
 */

export const AML_RULE_CODES = [
  'deposit_velocity',
  'withdrawal_velocity',
  'structuring',
  'deposit_then_withdraw',
  'cashout_churn',
] as const;
export type AmlRuleCode = (typeof AML_RULE_CODES)[number];

export const AML_SEVERITIES = ['low', 'medium', 'high'] as const;
export type AmlSeverity = (typeof AML_SEVERITIES)[number];

export interface AmlVelocityRule {
  enabled: boolean;
  severity: AmlSeverity;
  /** Fires when more than this many happen in a rolling hour. */
  maxPerHour: number;
  /** Fires when more than this many happen in a rolling 24 hours. */
  maxPerDay: number;
}

export interface AmlStructuringRule {
  enabled: boolean;
  severity: AmlSeverity;
  /** The reporting threshold deposits are kept under (santim). */
  reportingThreshold: Santim;
  /** A deposit is "just below" the threshold from this share of it (bps) up to it. */
  nearThresholdBps: number;
  /** Fires with this many deposits just below the threshold in one window... */
  minNearCount: number;
  /** ...or with two or more deposits below the threshold that sum to at least it. */
  windowHours: number;
}

export interface AmlDepositThenWithdrawRule {
  enabled: boolean;
  severity: AmlSeverity;
  /** Fires when a withdrawal is requested and the stakes since the last deposit are below this share of it (bps). */
  minStakeShareBps: number;
  /** Deposits below this are ignored (santim). */
  minDeposit: Santim;
}

export interface AmlCashOutChurnRule {
  enabled: boolean;
  severity: AmlSeverity;
  windowHours: number;
  /** Fires with this many quick cash-outs in one window. */
  minCount: number;
  /** A cash-out is quick when made at most this many minutes after the bet was placed. */
  maxMinutesAfterPlacement: number;
}

export interface AmlRules {
  /** Master switch. */
  enabled: boolean;
  /**
   * A player with an unresolved (open or escalated) high-severity flag has
   * every new withdrawal sent to staff review, and approved withdrawals not
   * yet sent go back to review when such a flag is raised.
   */
  holdWithdrawalsOnHighSeverity: boolean;
  depositVelocity: AmlVelocityRule;
  withdrawalVelocity: AmlVelocityRule;
  structuring: AmlStructuringRule;
  depositThenWithdraw: AmlDepositThenWithdrawRule;
  cashOutChurn: AmlCashOutChurnRule;
}

/** Defaults: placeholders to confirm with counsel (see docs/compliance.md). */
export const DEFAULT_AML_RULES: AmlRules = {
  enabled: true,
  holdWithdrawalsOnHighSeverity: true,
  depositVelocity: { enabled: true, severity: 'medium', maxPerHour: 5, maxPerDay: 10 },
  withdrawalVelocity: { enabled: true, severity: 'medium', maxPerHour: 3, maxPerDay: 5 },
  structuring: {
    enabled: true,
    severity: 'high',
    reportingThreshold: birr(100_000),
    nearThresholdBps: 9_000,
    minNearCount: 2,
    windowHours: 24,
  },
  depositThenWithdraw: {
    enabled: true,
    severity: 'high',
    minStakeShareBps: 5_000,
    minDeposit: birr(1_000),
  },
  cashOutChurn: {
    enabled: true,
    severity: 'medium',
    windowHours: 24,
    minCount: 5,
    maxMinutesAfterPlacement: 10,
  },
};

export const HOUR_MS = 3_600_000;

/** A rule that fired. */
export interface AmlHit {
  rule: AmlRuleCode;
  severity: AmlSeverity;
  /** The dedupe key of the window (a business date, or `deposit:<id>`). */
  windowKey: string;
  /** When it fired (epoch ms): the last event of the first window that broke the threshold. */
  atMs: number;
  /** What was seen (JSON-safe: santim as strings). */
  details: Record<string, string | number | boolean | null>;
}

function sortedTimes(times: readonly number[]): number[] {
  for (const t of times) {
    if (!Number.isFinite(t)) throw new RangeError('event times must be finite epoch milliseconds');
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * The earliest event time t at which the rolling window (t - windowMs, t]
 * holds more than `max` events, with that window's count; null when it
 * never does.
 */
export function firstCountBreach(
  timesMs: readonly number[],
  windowMs: number,
  max: number,
): { atMs: number; count: number } | null {
  if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('max must be a whole number');
  const times = sortedTimes(timesMs);
  let left = 0;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i]!;
    // Include every event at the same instant before judging the window ending at t.
    if (i + 1 < times.length && times[i + 1] === t) continue;
    while (times[left]! <= t - windowMs) left += 1;
    const count = i - left + 1;
    if (count > max) return { atMs: t, count };
  }
  return null;
}

function keyOf(atMs: number): string {
  return businessDateOf(new Date(atMs));
}

/** Deposit or withdrawal velocity: more than maxPerHour in an hour, or maxPerDay in 24 hours. */
export function evaluateVelocity(
  rule: 'deposit_velocity' | 'withdrawal_velocity',
  config: AmlVelocityRule,
  timesMs: readonly number[],
): AmlHit | null {
  if (!config.enabled) return null;
  const hour = firstCountBreach(timesMs, HOUR_MS, config.maxPerHour);
  const day = firstCountBreach(timesMs, 24 * HOUR_MS, config.maxPerDay);
  const first =
    hour !== null && (day === null || hour.atMs <= day.atMs)
      ? { ...hour, window: 'hour', max: config.maxPerHour }
      : day !== null
        ? { ...day, window: 'day', max: config.maxPerDay }
        : null;
  if (first === null) return null;
  return {
    rule,
    severity: config.severity,
    windowKey: keyOf(first.atMs),
    atMs: first.atMs,
    details: { window: first.window, count: first.count, max: first.max },
  };
}

/**
 * Structuring: within one rolling window of deposits below the reporting
 * threshold, either `minNearCount` of them are just below it, or two or
 * more of them sum to at least it. Deposits at or above the threshold are
 * reported as such and do not count.
 */
export function evaluateStructuring(
  config: AmlStructuringRule,
  deposits: ReadonlyArray<{ atMs: number; amount: Santim }>,
): AmlHit | null {
  if (!config.enabled) return null;
  const threshold = config.reportingThreshold;
  if (threshold <= 0n) return null;
  const nearFloor = (threshold * BigInt(config.nearThresholdBps)) / BPS_DENOMINATOR;
  const windowMs = config.windowHours * HOUR_MS;
  if (!(windowMs > 0)) throw new RangeError('windowHours must be positive');
  const below = deposits
    .filter((deposit) => deposit.amount > 0n && deposit.amount < threshold)
    .map((deposit) => ({ atMs: deposit.atMs, amount: deposit.amount }));
  for (const deposit of below) {
    if (!Number.isFinite(deposit.atMs)) throw new RangeError('deposit times must be finite');
  }
  below.sort((a, b) => a.atMs - b.atMs);
  let left = 0;
  let sum = 0n;
  let near = 0;
  for (let i = 0; i < below.length; i += 1) {
    const deposit = below[i]!;
    sum += deposit.amount;
    if (deposit.amount >= nearFloor) near += 1;
    if (i + 1 < below.length && below[i + 1]!.atMs === deposit.atMs) continue;
    while (below[left]!.atMs <= deposit.atMs - windowMs) {
      sum -= below[left]!.amount;
      if (below[left]!.amount >= nearFloor) near -= 1;
      left += 1;
    }
    const count = i - left + 1;
    const nearHit = near >= config.minNearCount && config.minNearCount > 0;
    const sumHit = count >= 2 && sum >= threshold;
    if (nearHit || sumHit) {
      return {
        rule: 'structuring',
        severity: config.severity,
        windowKey: keyOf(deposit.atMs),
        atMs: deposit.atMs,
        details: {
          count,
          total: sum.toString(),
          nearCount: near,
          threshold: threshold.toString(),
          reason: nearHit ? 'near_threshold' : 'sum_above_threshold',
        },
      };
    }
  }
  return null;
}

/**
 * Deposit then withdraw with little betting: a withdrawal is requested while
 * the stakes placed since the last deposit are below minStakeShareBps of
 * it. One hit per deposit (windowKey `deposit:<depositRef>`).
 */
export function evaluateDepositThenWithdraw(
  config: AmlDepositThenWithdrawRule,
  input: { deposit: Santim; stakesSince: Santim; depositRef: string; atMs: number },
): AmlHit | null {
  if (!config.enabled) return null;
  if (input.deposit <= 0n || input.deposit < config.minDeposit) return null;
  if (input.stakesSince < 0n) throw new RangeError('stakesSince must not be negative');
  // stakes / deposit < share / 10000, without division.
  if (input.stakesSince * BPS_DENOMINATOR >= input.deposit * BigInt(config.minStakeShareBps)) {
    return null;
  }
  return {
    rule: 'deposit_then_withdraw',
    severity: config.severity,
    windowKey: `deposit:${input.depositRef}`,
    atMs: input.atMs,
    details: {
      deposit: input.deposit.toString(),
      stakesSince: input.stakesSince.toString(),
      minStakeShareBps: config.minStakeShareBps,
    },
  };
}

/** Rapid cash-out churn: minCount quick cash-outs (soon after placement) within one window. */
export function evaluateCashOutChurn(
  config: AmlCashOutChurnRule,
  cashOuts: ReadonlyArray<{ atMs: number; placedAtMs: number }>,
): AmlHit | null {
  if (!config.enabled || config.minCount < 1) return null;
  const quickMs = config.maxMinutesAfterPlacement * 60_000;
  const quick = cashOuts
    .filter((cashOut) => cashOut.atMs - cashOut.placedAtMs <= quickMs)
    .map((cashOut) => cashOut.atMs);
  const breach = firstCountBreach(quick, config.windowHours * HOUR_MS, config.minCount - 1);
  if (breach === null) return null;
  return {
    rule: 'cashout_churn',
    severity: config.severity,
    windowKey: keyOf(breach.atMs),
    atMs: breach.atMs,
    details: {
      count: breach.count,
      minCount: config.minCount,
      maxMinutesAfterPlacement: config.maxMinutesAfterPlacement,
    },
  };
}

/** One player's recent activity for the time-window rules (epoch ms, santim). */
export interface AmlActivity {
  deposits: ReadonlyArray<{ atMs: number; amount: Santim }>;
  withdrawals: ReadonlyArray<{ atMs: number }>;
  cashOuts: ReadonlyArray<{ atMs: number; placedAtMs: number }>;
}

/** Every time-window rule that fires on the activity (deposit_then_withdraw is per withdrawal). */
export function evaluateAmlActivity(rules: AmlRules, activity: AmlActivity): AmlHit[] {
  if (!rules.enabled) return [];
  const hits = [
    evaluateVelocity(
      'deposit_velocity',
      rules.depositVelocity,
      activity.deposits.map((deposit) => deposit.atMs),
    ),
    evaluateVelocity(
      'withdrawal_velocity',
      rules.withdrawalVelocity,
      activity.withdrawals.map((withdrawal) => withdrawal.atMs),
    ),
    evaluateStructuring(rules.structuring, activity.deposits),
    evaluateCashOutChurn(rules.cashOutChurn, activity.cashOuts),
  ];
  return hits.filter((hit): hit is AmlHit => hit !== null);
}

/** How far back the time-window rules look (the longest window, doubled so a burst is seen whole). */
export function amlLookbackMs(rules: AmlRules): number {
  const hours = Math.max(24, rules.structuring.windowHours, rules.cashOutChurn.windowHours);
  return 2 * hours * HOUR_MS;
}

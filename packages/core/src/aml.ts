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
 * events in (t - W, t]. A time-window rule fires once per business day
 * (Africa/Addis_Ababa): at the earliest event time t of that day whose
 * window breaks the threshold, with the business date of t as its
 * windowKey. Evaluating again later (another deposit in the same burst,
 * the daily sweep) finds the same t and key, so the flag is not repeated,
 * while a new burst on a later day gets a flag of its own.
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

const HOUR_MS = 3_600_000;

/** A rule that fired. */
export interface AmlHit {
  rule: AmlRuleCode;
  severity: AmlSeverity;
  /** The dedupe key of the window (a business date, or `deposit:<id>`). */
  windowKey: string;
  /** When it fired (epoch ms): the last event of the first window of its key that broke the threshold. */
  atMs: number;
  /** What was seen (JSON-safe: santim as strings). */
  details: Record<string, string | number | boolean | null>;
}

function assertTimes(times: readonly number[], what: string): void {
  for (const t of times) {
    if (!Number.isFinite(t)) throw new RangeError(`${what} must be finite epoch milliseconds`);
  }
}

function assertWholeCount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a whole number`);
  }
}

function windowMsOf(hours: number, what: string): number {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError(`${what} must be positive`);
  return hours * HOUR_MS;
}

/**
 * Every event time t (each distinct instant once, oldest first) at which the
 * rolling window (t - windowMs, t] holds more than `max` events, with that
 * window's count.
 */
export function countBreaches(
  timesMs: readonly number[],
  windowMs: number,
  max: number,
): Array<{ atMs: number; count: number }> {
  if (!(windowMs > 0)) throw new RangeError('windowMs must be positive');
  assertWholeCount(max, 'max');
  assertTimes(timesMs, 'event times');
  const times = [...timesMs].sort((a, b) => a - b);
  const breaches: Array<{ atMs: number; count: number }> = [];
  let left = 0;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i]!;
    // Count every event at the same instant before judging the window ending at t.
    if (i + 1 < times.length && times[i + 1] === t) continue;
    while (times[left]! <= t - windowMs) left += 1;
    const count = i - left + 1;
    if (count > max) breaches.push({ atMs: t, count });
  }
  return breaches;
}

/** The dedupe key of a time-window hit: the business date (Addis Ababa) it fired on. */
export function amlWindowKey(atMs: number): string {
  return businessDateOf(new Date(atMs));
}

/** The earliest item of each window key (items sorted by atMs, ties keep the first). */
function firstPerKey<T extends { atMs: number }>(items: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  const sorted = [...items].sort((a, b) => a.atMs - b.atMs);
  for (const item of sorted) {
    const key = amlWindowKey(item.atMs);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

/**
 * Deposit or withdrawal velocity: more than maxPerHour in a rolling hour, or
 * more than maxPerDay in a rolling 24 hours. One hit per business day on
 * which a window first broke a limit.
 */
export function evaluateVelocity(
  rule: 'deposit_velocity' | 'withdrawal_velocity',
  config: AmlVelocityRule,
  timesMs: readonly number[],
): AmlHit[] {
  if (!config.enabled) return [];
  const breaches = [
    ...countBreaches(timesMs, HOUR_MS, config.maxPerHour).map((breach) => ({
      ...breach,
      window: 'hour',
      max: config.maxPerHour,
    })),
    ...countBreaches(timesMs, 24 * HOUR_MS, config.maxPerDay).map((breach) => ({
      ...breach,
      window: 'day',
      max: config.maxPerDay,
    })),
  ];
  return firstPerKey(breaches).map((breach) => ({
    rule,
    severity: config.severity,
    windowKey: amlWindowKey(breach.atMs),
    atMs: breach.atMs,
    details: { window: breach.window, count: breach.count, max: breach.max },
  }));
}

/**
 * Structuring: within one rolling window (windowHours) of deposits below the
 * reporting threshold, either `minNearCount` of them are just below it (at
 * least nearThresholdBps of it), or two or more of them sum to at least it.
 * Deposits at or above the threshold are reported as such and do not count.
 * One hit per business day on which a window first matched.
 */
export function evaluateStructuring(
  config: AmlStructuringRule,
  deposits: ReadonlyArray<{ atMs: number; amount: Santim }>,
): AmlHit[] {
  if (!config.enabled) return [];
  const threshold = config.reportingThreshold;
  if (threshold <= 0n) return [];
  const windowMs = windowMsOf(config.windowHours, 'windowHours');
  const nearFloor = (threshold * BigInt(config.nearThresholdBps)) / BPS_DENOMINATOR;
  assertTimes(
    deposits.map((deposit) => deposit.atMs),
    'deposit times',
  );
  const below = deposits
    .filter((deposit) => deposit.amount > 0n && deposit.amount < threshold)
    .map((deposit) => ({ atMs: deposit.atMs, amount: deposit.amount }))
    .sort((a, b) => a.atMs - b.atMs);
  const matches: Array<{ atMs: number; count: number; sum: Santim; near: number; reason: string }> =
    [];
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
    const nearHit = config.minNearCount > 0 && near >= config.minNearCount;
    const sumHit = count >= 2 && sum >= threshold;
    if (nearHit || sumHit) {
      matches.push({
        atMs: deposit.atMs,
        count,
        sum,
        near,
        reason: nearHit ? 'near_threshold' : 'sum_above_threshold',
      });
    }
  }
  return firstPerKey(matches).map((match) => ({
    rule: 'structuring',
    severity: config.severity,
    windowKey: amlWindowKey(match.atMs),
    atMs: match.atMs,
    details: {
      count: match.count,
      total: match.sum.toString(),
      nearCount: match.near,
      threshold: threshold.toString(),
      reason: match.reason,
    },
  }));
}

/**
 * Deposit then withdraw with little betting: a withdrawal is requested while
 * the stakes placed since the last deposit are below minStakeShareBps of
 * that deposit. One hit per deposit (windowKey `deposit:<depositRef>`).
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

/** How far back the deposit-then-withdraw rule looks for deposits at most (days). */
export const DEPOSIT_THEN_WITHDRAW_LOOKBACK_DAYS = 30;

/** A deposit a withdrawal is judged against, with the stakes placed from it up to the request. */
export interface DepositBeforeWithdrawal {
  ref: string;
  atMs: number;
  amount: Santim;
  /** Bet stakes and jackpot entry costs placed from this deposit up to the withdrawal request. */
  stakesSince: Santim;
}

/**
 * Deposit then withdraw over every deposit since the player's previous
 * withdrawal (at most DEPOSIT_THEN_WITHDRAW_LOOKBACK_DAYS back), so a small
 * top-up cannot hide an unplayed deposit before it: for each deposit d (in
 * time order), the deposits from d on are summed and the stakes placed
 * since d are compared with that sum (evaluateDepositThenWithdraw). The
 * hit is keyed on the earliest deposit that breaks the rule (stable for a
 * withdrawal, and disjoint between withdrawals). Adding a deposit never
 * clears a hit: it raises every sum and leaves the stakes as they are.
 */
export function evaluateDepositsThenWithdraw(
  config: AmlDepositThenWithdrawRule,
  input: { deposits: readonly DepositBeforeWithdrawal[]; atMs: number },
): AmlHit | null {
  if (!config.enabled) return null;
  const deposits = [...input.deposits].sort(
    (a, b) => a.atMs - b.atMs || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  );
  assertTimes(
    deposits.map((d) => d.atMs),
    'deposit times',
  );
  const suffix: Santim[] = new Array<Santim>(deposits.length);
  let sum = 0n;
  for (let i = deposits.length - 1; i >= 0; i -= 1) {
    const amount = deposits[i]!.amount;
    if (amount < 0n) throw new RangeError('a deposit amount must not be negative');
    sum += amount;
    suffix[i] = sum;
  }
  for (let i = 0; i < deposits.length; i += 1) {
    const deposit = deposits[i]!;
    const hit = evaluateDepositThenWithdraw(config, {
      deposit: suffix[i]!,
      stakesSince: deposit.stakesSince,
      depositRef: deposit.ref,
      atMs: input.atMs,
    });
    if (hit !== null) return { ...hit, details: { ...hit.details, deposits: deposits.length - i } };
  }
  return null;
}

/**
 * Rapid cash-out churn: at least minCount quick cash-outs (made at most
 * maxMinutesAfterPlacement after the bet was placed) within one rolling
 * window. One hit per business day on which a window first reached it.
 */
export function evaluateCashOutChurn(
  config: AmlCashOutChurnRule,
  cashOuts: ReadonlyArray<{ atMs: number; placedAtMs: number }>,
): AmlHit[] {
  if (!config.enabled || config.minCount < 1) return [];
  const windowMs = windowMsOf(config.windowHours, 'windowHours');
  const quickMs = config.maxMinutesAfterPlacement * 60_000;
  const quick = cashOuts
    .filter((cashOut) => cashOut.atMs - cashOut.placedAtMs <= quickMs)
    .map((cashOut) => cashOut.atMs);
  return firstPerKey(countBreaches(quick, windowMs, config.minCount - 1)).map((breach) => ({
    rule: 'cashout_churn',
    severity: config.severity,
    windowKey: amlWindowKey(breach.atMs),
    atMs: breach.atMs,
    details: {
      count: breach.count,
      minCount: config.minCount,
      maxMinutesAfterPlacement: config.maxMinutesAfterPlacement,
    },
  }));
}

/** One player's recent activity for the time-window rules (epoch ms, santim). */
export interface AmlActivity {
  deposits: ReadonlyArray<{ atMs: number; amount: Santim }>;
  withdrawals: ReadonlyArray<{ atMs: number }>;
  cashOuts: ReadonlyArray<{ atMs: number; placedAtMs: number }>;
}

/** Every hit of the time-window rules (deposit_then_withdraw is judged per withdrawal). */
export function evaluateAmlActivity(rules: AmlRules, activity: AmlActivity): AmlHit[] {
  if (!rules.enabled) return [];
  return [
    ...evaluateVelocity(
      'deposit_velocity',
      rules.depositVelocity,
      activity.deposits.map((deposit) => deposit.atMs),
    ),
    ...evaluateVelocity(
      'withdrawal_velocity',
      rules.withdrawalVelocity,
      activity.withdrawals.map((withdrawal) => withdrawal.atMs),
    ),
    ...evaluateStructuring(rules.structuring, activity.deposits),
    ...evaluateCashOutChurn(rules.cashOutChurn, activity.cashOuts),
  ];
}

/**
 * How far back the evaluation looks: twice the longest window, so every
 * window ending in the latest half is seen whole (an evaluation can miss a
 * window cut by the start of the look-back, never invent one).
 */
export function amlLookbackMs(rules: AmlRules): number {
  const hours = Math.max(24, rules.structuring.windowHours, rules.cashOutChurn.windowHours);
  return 2 * hours * HOUR_MS;
}

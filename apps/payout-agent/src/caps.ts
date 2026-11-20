/**
 * The agent's own limits (docs/plans/payout-sender-design.md, section 3,
 * rule 6). The server has the same limits; these are read from a file on the
 * agent's machine that the server cannot change, so a mistake or a break-in
 * on the server cannot make the agent send more than its owner allowed.
 * Pure: amounts are `bigint` santim, times are epoch milliseconds.
 */

export interface SendCaps {
  /** The most one send may be. */
  maxPerSend: bigint;
  /** Sends that left or may have left the wallet, in any 60 minutes. */
  maxSendsPerHour: number;
  maxSumPerHour: bigint;
  /** Since the shift began. */
  maxSumPerShift: bigint;
  /** In one day of East Africa Time (UTC+3), where the wallet's own daily limit is counted. */
  maxSumPerDay: bigint;
  /** The least time between the starts of two attempts. A safety pace, nothing else. */
  minPauseMs: number;
}

export interface SendEntry {
  /** When the attempt began. */
  at: number;
  amount: bigint;
  outcome: 'sent' | 'unknown' | 'not_sent';
}

export type CapRefusal =
  | 'invalid_caps'
  | 'invalid_amount'
  | 'over_send_cap'
  | 'too_soon'
  | 'over_hour_count'
  | 'over_hour_sum'
  | 'over_shift_sum'
  | 'over_day_sum';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const EAT_OFFSET_MS = 3 * HOUR_MS;

/** The start of the East Africa Time day that holds `now`. */
export function eatDayStart(now: number): number {
  return Math.floor((now + EAT_OFFSET_MS) / DAY_MS) * DAY_MS - EAT_OFFSET_MS;
}

function capsAreValid(caps: SendCaps): boolean {
  const sums = [caps.maxPerSend, caps.maxSumPerHour, caps.maxSumPerShift, caps.maxSumPerDay];
  return (
    sums.every((sum) => typeof sum === 'bigint' && sum >= 0n) &&
    Number.isInteger(caps.maxSendsPerHour) &&
    caps.maxSendsPerHour >= 0 &&
    Number.isFinite(caps.minPauseMs) &&
    caps.minPauseMs >= 0
  );
}

/**
 * Why a send of `amount` may not start now, or null when it may. An attempt
 * whose outcome is `unknown` counts as money that left: it may have. One
 * that certainly did not send counts only for the pause.
 */
export function checkSendCaps(input: {
  caps: SendCaps;
  history: readonly SendEntry[];
  shiftStartedAt: number;
  now: number;
  amount: bigint;
}): CapRefusal | null {
  const { caps, history, shiftStartedAt, now, amount } = input;
  if (!capsAreValid(caps)) return 'invalid_caps';
  if (typeof amount !== 'bigint' || amount <= 0n) return 'invalid_amount';
  if (amount > caps.maxPerSend) return 'over_send_cap';

  const latest = history.reduce((max, entry) => Math.max(max, entry.at), Number.NEGATIVE_INFINITY);
  if (now - latest < caps.minPauseMs) return 'too_soon';

  const left = history.filter((entry) => entry.outcome !== 'not_sent');
  const sumSince = (from: number) =>
    left.filter((entry) => entry.at >= from).reduce((sum, entry) => sum + entry.amount, 0n);

  const hourAgo = now - HOUR_MS;
  if (left.filter((entry) => entry.at > hourAgo).length + 1 > caps.maxSendsPerHour) {
    return 'over_hour_count';
  }
  if (sumSince(hourAgo + 1) + amount > caps.maxSumPerHour) return 'over_hour_sum';
  if (sumSince(shiftStartedAt) + amount > caps.maxSumPerShift) return 'over_shift_sum';
  if (sumSince(eatDayStart(now)) + amount > caps.maxSumPerDay) return 'over_day_sum';
  return null;
}

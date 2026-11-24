/**
 * Payout float forecast (plan task C10): how much the players are expected to withdraw in the next
 * hours, from the open bets, what they could pay and when their matches end. Pure: no I/O, bigint
 * santim, rounded down.
 *
 * Assumptions (each is a rule, so the owner can tune it):
 * - a bet can only be paid once its last event has ended. The catalogue has no end time, so an
 *   event ends `eventDurationMs` after its start; a bet whose events ended already but is not
 *   settled yet still counts (its payout is due any minute);
 * - only bets whose last event ends within `horizonMs` of now count; later bets cannot pay in the
 *   horizon;
 * - of the net payout each such bet could pay (`potentialNetPayout`, after tax), the share
 *   `withdrawnShareBps` is expected to leave through withdrawals within the horizon. It covers
 *   both that most open bets lose and that winners often keep money in their wallet to bet again.
 *   It is a plain share, not a probability model: 10000 = every possible payout is withdrawn.
 */

export interface OpenBetExposure {
  /** Santim: the net payout the bet pays if it wins. */
  potentialNetPayout: bigint;
  /** The start of the bet's latest-starting event (the bet is paid after that one ends). */
  lastEventStart: Date;
}

export interface FloatForecastRules {
  /** Milliseconds from an event's start to its end (default 2 hours: football with a break). */
  eventDurationMs: number;
  /** Milliseconds ahead of now that the forecast covers (default 6 hours). */
  horizonMs: number;
  /** Basis points (0..10000) of a possible payout expected to be withdrawn (default 20%). */
  withdrawnShareBps: number;
}

export const DEFAULT_FLOAT_FORECAST_RULES: FloatForecastRules = {
  eventDurationMs: 2 * 60 * 60_000,
  horizonMs: 6 * 60 * 60_000,
  withdrawnShareBps: 2000,
};

export interface FloatForecast {
  /** Santim expected to be withdrawn within the horizon; never negative. */
  expectedWithdrawals: bigint;
  /** The bets that count (their last event ends within the horizon). */
  betsCounted: number;
  /** Santim: the sum of their possible net payouts, before the share. */
  possiblePayouts: bigint;
}

export function forecastPayoutFloat(
  bets: readonly OpenBetExposure[],
  now: Date,
  rules: FloatForecastRules = DEFAULT_FLOAT_FORECAST_RULES,
): FloatForecast {
  const share = BigInt(Math.min(10_000, Math.max(0, Math.trunc(rules.withdrawnShareBps))));
  const horizonEnd = now.getTime() + rules.horizonMs;
  let betsCounted = 0;
  let possiblePayouts = 0n;
  for (const bet of bets) {
    if (bet.potentialNetPayout <= 0n) continue;
    const endsAt = bet.lastEventStart.getTime() + rules.eventDurationMs;
    if (endsAt > horizonEnd) continue;
    betsCounted += 1;
    possiblePayouts += bet.potentialNetPayout;
  }
  // One rounding on the sum (down), so the forecast never exceeds the exact share.
  return { expectedWithdrawals: (possiblePayouts * share) / 10_000n, betsCounted, possiblePayouts };
}

/** True when the last known balance cannot cover the forecast. */
export function floatIsLow(balance: bigint, forecast: FloatForecast): boolean {
  return forecast.expectedWithdrawals > 0n && balance < forecast.expectedWithdrawals;
}

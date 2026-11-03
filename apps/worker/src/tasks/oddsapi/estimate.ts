import {
  MINUTE_MS,
  nextOddsPollAt,
  nextScoresPollAt,
  nothingToPrice,
  type Budget,
} from './schedule';

/**
 * What a league costs in credits under the poll schedule, found by walking a
 * fixture calendar through the same functions the worker uses (nextOddsPollAt,
 * nothingToPrice, nextScoresPollAt). For planning a plan's leagues
 * (docs/odds-api-integration-plan.md §9) and for tests that keep the default
 * leagues inside their share; not used to poll.
 *
 * Simplified: prematch only (in-play off), kick-offs at the same time count
 * once (one call covers a league's every event), a result stands
 * `confirmMs` after the first completed read, and the catalogue sync never
 * brings a poll forward.
 */
export interface LeagueCalendar {
  /** Distinct kick-off times, ascending. */
  kickoffs: readonly Date[];
  /** Credits of one odds call (markets × regions: 2 for h2h,totals in one region). */
  oddsCost: number;
  /** How long a match lasts before its result can be read (expectedMatchMs). */
  matchMs: number;
}

export interface CreditEstimate {
  oddsCalls: number;
  odds: number;
  scoresCalls: number;
  scores: number;
  total: number;
}

export function estimateLeagueCredits(
  calendar: LeagueCalendar,
  options: { from: Date; to: Date; factor: number; confirmMs?: number },
): CreditEstimate {
  const budget: Budget = { factor: options.factor, mode: 'normal' };
  const kickoffs = calendar.kickoffs.map((kickoff) => kickoff.getTime());
  const end = options.to.getTime();
  const estimate: CreditEstimate = { oddsCalls: 0, odds: 0, scoresCalls: 0, scores: 0, total: 0 };

  // Odds: one call per due poll with something to price inside the horizon.
  for (let t = options.from.getTime(); t < end;) {
    const now = new Date(t);
    const next = kickoffs.find((kickoff) => kickoff > t);
    const nextStartAt = next === undefined ? null : new Date(next);
    const league = { now, nextStartAt, liveCount: 0, inPlay: false };
    if (!nothingToPrice(league)) {
      estimate.oddsCalls++;
      estimate.odds += calendar.oddsCost;
    }
    t = Math.max(t + MINUTE_MS, nextOddsPollAt({ ...league, budget }).getTime());
  }

  // Scores: called only while a started match awaits its result; 2 credits
  // with daysFrom (once the oldest should be over), else 1.
  const confirmMs = options.confirmMs ?? 10 * MINUTE_MS;
  const seen = new Map<number, number>();
  const resulted = (kickoff: number, t: number): boolean => {
    const at = seen.get(kickoff);
    return at !== undefined && t >= at + confirmMs;
  };
  for (let t = options.from.getTime(); t < end;) {
    const started = kickoffs.filter((kickoff) => kickoff <= t && !resulted(kickoff, t));
    let live = false;
    let awaiting = false;
    if (started.length > 0) {
      const oldest = Math.min(...started);
      estimate.scoresCalls++;
      estimate.scores += t - oldest >= calendar.matchMs ? 2 : 1;
      for (const kickoff of started) {
        if (t < kickoff + calendar.matchMs) live = true;
        else {
          awaiting = true;
          if (!seen.has(kickoff)) seen.set(kickoff, t);
        }
      }
    }
    const nextAt = nextScoresPollAt({
      now: new Date(t),
      live,
      awaitingResults: awaiting,
      budget,
      inPlay: false,
    }).getTime();
    t = Math.max(t + MINUTE_MS, nextAt);
  }
  estimate.total = estimate.odds + estimate.scores;
  return estimate;
}

/**
 * The smallest budget factor (1 to 24, to 0.05) at which `leagues` fit
 * `credits` over the span, or null when they do not fit even at 24.
 */
export function factorToFit(
  leagues: readonly LeagueCalendar[],
  credits: number,
  span: { from: Date; to: Date },
): number | null {
  const cost = (factor: number): number =>
    leagues.reduce(
      (sum, league) => sum + estimateLeagueCredits(league, { ...span, factor }).total,
      0,
    );
  if (cost(1) <= credits) return 1;
  if (cost(24) > credits) return null;
  let low = 1;
  let high = 24;
  while (high - low > 0.05) {
    const mid = (low + high) / 2;
    if (cost(mid) <= credits) high = mid;
    else low = mid;
  }
  return Math.round(high * 100) / 100;
}

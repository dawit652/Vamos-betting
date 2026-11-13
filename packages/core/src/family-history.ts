import { MAX_FAMILY_MARGIN_BPS } from './market-families';

/**
 * The history test of the market factory's families (check 0.6 of
 * docs/plans/hulusport-parity-plan.md, task A2): over past matches, each family's selections are
 * priced from the fitted expected goals and scored against what happened. Pure: the evaluator in
 * apps/scraper accumulates the statistics; this file turns them into a verdict, and the weekly
 * family job asks it whether a suspended family may return at its raised margin.
 *
 * Margins are bps of overround, never money; the floating point here only measures.
 */

/**
 * One selection (one line and code of a family) over the sample: for every match where it was
 * listed and not void, `ratio` is won / p (1/p when it won, 0 when it lost), with p the model's
 * fair probability. A bettor staking one unit at fair odds every time gets back mean(ratio), so
 * mean(ratio) − 1 is the fair yield: positive when the model under-prices what happens.
 */
export interface SelectionHistory {
  /** Line and code, e.g. `2.5|over`. */
  key: string;
  /** Matches where it was listed and decided (void excluded). */
  n: number;
  /** Times it won. */
  wins: number;
  /** Sum of the model's fair probabilities (expected wins). */
  sumP: number;
  /** Sum of won / p. */
  sumRatio: number;
  /** Sum of (won / p)². */
  sumRatioSq: number;
}

/** Fewer decided matches than this and a selection says nothing about the margin. */
export const HISTORY_MIN_SELECTION_N = 200;
/** One-sided 95%: a selection raises the margin only when its fair yield is above zero by this many standard errors. */
export const HISTORY_Z = 1.645;
/** Suggested margins are whole points (100 bps). */
export const HISTORY_MARGIN_STEP_BPS = 100;
/** A history test older than this no longer lets a family return. */
export const HISTORY_MAX_AGE_DAYS = 400;

/** The fair yield of a selection and its one-sided lower bound; null below the sample floor. */
export function selectionFairYield(
  s: SelectionHistory,
): { yield: number; lower: number; se: number } | null {
  if (!Number.isFinite(s.n) || s.n < HISTORY_MIN_SELECTION_N) return null;
  const mean = s.sumRatio / s.n;
  const variance = Math.max(0, s.sumRatioSq / s.n - mean * mean);
  // Sample standard error of the mean (n − 1 in the variance).
  const se = Math.sqrt((variance * s.n) / (s.n - 1) / s.n);
  const value = mean - 1;
  if (!Number.isFinite(value) || !Number.isFinite(se)) return null;
  return { yield: value, lower: value - HISTORY_Z * se, se };
}

/**
 * The margin a family needs so that no selection with enough history beats it at our price: a
 * bettor's yield at overround m is about (1 + fair yield) / (1 + m) − 1, negative when m is above
 * the fair yield. So the suggestion is the largest lower bound of a selection's fair yield, in
 * bps, rounded UP to a whole point, never below `classMarginBps` and never above
 * MAX_FAMILY_MARGIN_BPS. Selections below the sample floor are ignored.
 */
export function suggestFamilyMarginBps(
  selections: readonly SelectionHistory[],
  classMarginBps: number,
): number {
  if (!Number.isSafeInteger(classMarginBps) || classMarginBps < 0) {
    throw new RangeError(`classMarginBps must be a whole number >= 0, got ${classMarginBps}`);
  }
  let worst = 0;
  for (const s of selections) {
    const fy = selectionFairYield(s);
    if (fy !== null && fy.lower > worst) worst = fy.lower;
  }
  const needed = Math.ceil((worst * 10_000) / HISTORY_MARGIN_STEP_BPS) * HISTORY_MARGIN_STEP_BPS;
  return Math.min(MAX_FAMILY_MARGIN_BPS, Math.max(classMarginBps, needed));
}

/** One family's line of the history test, as stored (setting `market_family_history`). */
export interface FamilyHistoryVerdict {
  family: string;
  /** Matches where the family was priced. */
  matches: number;
  /** Selections staked (listed and decided). */
  selections: number;
  /** The margin it was tested at (the class margin, or the family's own in the settings). */
  marginBps: number;
  /** What the model's prices kept at that margin: 1 − returns / stakes, in bps (negative: lost). */
  holdBps: number;
  /** suggestFamilyMarginBps of its selections. */
  suggestedMarginBps: number;
  /** The worst selection with enough history, if any: its key and lower bound in bps. */
  worst: { key: string; lowerBps: number; n: number } | null;
  /** True when suggestedMarginBps <= marginBps and the hold was not negative. */
  passed: boolean;
}

/** The verdict of one family from its statistics. */
export function familyHistoryVerdict(input: {
  family: string;
  matches: number;
  selections: readonly SelectionHistory[];
  marginBps: number;
  stakes: number;
  returns: number;
}): FamilyHistoryVerdict {
  const suggested = suggestFamilyMarginBps(input.selections, input.marginBps);
  let worst: FamilyHistoryVerdict['worst'] = null;
  for (const s of input.selections) {
    const fy = selectionFairYield(s);
    if (fy === null) continue;
    const lowerBps = Math.round(fy.lower * 10_000);
    if (worst === null || lowerBps > worst.lowerBps) worst = { key: s.key, lowerBps, n: s.n };
  }
  const holdBps = input.stakes > 0 ? Math.round((1 - input.returns / input.stakes) * 10_000) : 0;
  return {
    family: input.family,
    matches: input.matches,
    selections: input.selections.reduce((sum, s) => sum + s.n, 0),
    marginBps: input.marginBps,
    holdBps,
    suggestedMarginBps: suggested,
    worst,
    passed: input.stakes > 0 && suggested <= input.marginBps && holdBps >= 0,
  };
}

/**
 * Whether a suspended family may return at `raisedMarginBps` (the weekly job's
 * `historyTestPassed`): a stored history test exists for it, is at most HISTORY_MAX_AGE_DAYS old,
 * had a sample (`selections` > 0), and its suggested margin is at or below the raised margin.
 */
export function historyTestPassedAt(
  verdict: Pick<FamilyHistoryVerdict, 'suggestedMarginBps' | 'selections'> | undefined,
  raisedMarginBps: number,
  testedAt: Date | null,
  now: Date,
): boolean {
  if (verdict === undefined || testedAt === null) return false;
  if (!(verdict.selections > 0)) return false;
  const ageMs = now.getTime() - testedAt.getTime();
  if (!(ageMs >= 0) || ageMs > HISTORY_MAX_AGE_DAYS * 86_400_000) return false;
  return verdict.suggestedMarginBps <= raisedMarginBps;
}

import { type Santim, SANTIM_PER_BIRR } from './money';

/**
 * House liability caps (rule L1 of docs/therundown-plan/README.md): the most the house is
 * willing to owe if one outcome, or every open bet on one match, wins.
 *
 * Liability here is what the Risk page already shows: the sum of the potential gross payouts of
 * the open bets with an open leg on the selection (or the match). A multiple counts its whole
 * potential payout on each of its selections, so the figure is an upper bound. A match's
 * liability counts each bet once, however many of its legs are on that match, and adds up every
 * market, which over-states what one result can cost: a deliberately cautious figure.
 *
 * Pure: no I/O. Money is bigint santim.
 */
export interface RiskLimits {
  /** Largest liability on one selection; null = no cap. */
  maxSelectionLiability: Santim | null;
  /** Largest liability on one match; null = no cap. */
  maxEventLiability: Santim | null;
}

/** No caps: the demo's behaviour. Staff set the caps in the back office (settings `risk_limits`). */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxSelectionLiability: null,
  maxEventLiability: null,
};

/**
 * The caps of a competitor board's own matches (Hulusport's and Narobet's, docs/plans/
 * narobet-events.md): one price source and one results source, mostly small leagues. Owner's
 * decision D4 of 21 Nov 2026: at most ETB 20,000 paid out per match. Staff change it in the back
 * office (settings `board_risk_limits`). It applies on top of `risk_limits`: the stricter cap wins.
 */
export const DEFAULT_BOARD_RISK_LIMITS: RiskLimits = {
  maxSelectionLiability: null,
  maxEventLiability: 20_000n * SANTIM_PER_BIRR,
};

/** True when at least one cap is set (otherwise placing a bet needs no exposure check). */
export function hasRiskLimits(limits: RiskLimits): boolean {
  return limits.maxSelectionLiability !== null || limits.maxEventLiability !== null;
}

/** The stricter of two caps (null = no cap). */
export function strictestCap(a: Santim | null, b: Santim | null): Santim | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/**
 * The board caps of one bet (see DEFAULT_BOARD_RISK_LIMITS): the caps, and which of the bet's
 * matches and selections are on a board's own matches. Absent, or with no board match, the bet
 * has only the plain caps.
 */
export interface BoardRiskInput {
  limits: RiskLimits;
  events: ReadonlySet<string>;
  selections: ReadonlySet<string>;
}

/** True when a bet must be checked against the caps (plain, or board caps on a board match). */
export function needsLiabilityCheck(limits: RiskLimits, board?: BoardRiskInput): boolean {
  if (hasRiskLimits(limits)) return true;
  return board !== undefined && board.events.size > 0 && hasRiskLimits(board.limits);
}

export type LiabilityScope = 'selection' | 'event';

/** The open liability of one selection or match, before the new bet. */
export interface LiabilityExposure {
  id: string;
  current: Santim;
}

export interface LiabilityBreach {
  scope: LiabilityScope;
  id: string;
  cap: Santim;
  current: Santim;
  /** cap − current, never below 0: what is left for a new bet's payout. */
  headroom: Santim;
}

/**
 * The scope with the least room left when the new bet's `payout` does not fit in it, else null.
 * A payout fits when `current + payout <= cap` for every scope it touches. Ties go to a
 * selection, then to the lower id, so the answer does not depend on the order of the input.
 * A cap already exceeded (for instance one lowered after bets were taken) has no room at all.
 */
export function liabilityBreach(input: {
  payout: Santim;
  selections: readonly LiabilityExposure[];
  events: readonly LiabilityExposure[];
  limits: RiskLimits;
  /**
   * Selections of the market factory's markets (plan task 2.5): their cap is
   * `factoryShareBps` of the selection cap (`selectionLiabilityCap`).
   */
  factorySelections?: ReadonlySet<string>;
  /**
   * The factory selections' share of the selection cap, in basis points (settings
   * `market_families.factoryLiabilityShareBps`); default FACTORY_SELECTION_LIABILITY_SHARE_BPS.
   */
  factoryShareBps?: number;
  /**
   * The board caps (settings `board_risk_limits`) and the board matches and selections among the
   * scopes: those take the stricter of their plain cap and their board cap.
   */
  board?: BoardRiskInput;
}): LiabilityBreach | null {
  const { payout, selections, events, limits, factorySelections, factoryShareBps, board } = input;
  if (payout < 0n) throw new RangeError(`payout must not be negative (got ${payout})`);
  let tightest: LiabilityBreach | null = null;
  const consider = (
    scope: LiabilityScope,
    exposures: readonly LiabilityExposure[],
    capOf: (id: string) => Santim | null,
  ): void => {
    for (const { id, current } of exposures) {
      const cap = capOf(id);
      if (cap === null) continue;
      if (current + payout <= cap) continue;
      const headroom = cap > current ? cap - current : 0n;
      const candidate: LiabilityBreach = { scope, id, cap, current, headroom };
      if (tightest === null || isTighter(candidate, tightest)) tightest = candidate;
    }
  };
  consider('selection', selections, (id) => {
    const factory = factorySelections?.has(id) === true;
    const plain = selectionLiabilityCap(limits, factory, factoryShareBps);
    if (board === undefined || !board.selections.has(id)) return plain;
    return strictestCap(plain, selectionLiabilityCap(board.limits, factory, factoryShareBps));
  });
  consider('event', events, (id) =>
    board !== undefined && board.events.has(id)
      ? strictestCap(limits.maxEventLiability, board.limits.maxEventLiability)
      : limits.maxEventLiability,
  );
  return tightest;
}

/**
 * Plan task 2.5 ("shown with low limits"): a selection of the market factory's markets starts at
 * a quarter of the selection liability cap, the limit of a league at stage 2 (4.3). The default of
 * the setting `market_families.factoryLiabilityShareBps`, which staff change in the back office.
 */
export const FACTORY_SELECTION_LIABILITY_SHARE_BPS = 2_500;

/**
 * The liability cap of one selection: `maxSelectionLiability`, or for a selection of a factory
 * market `shareBps` of it (default FACTORY_SELECTION_LIABILITY_SHARE_BPS, rounded down; a share
 * above 10,000 is refused, so a factory cap is never looser than the plain one). Null: no cap.
 */
export function selectionLiabilityCap(
  limits: RiskLimits,
  factory: boolean,
  shareBps: number = FACTORY_SELECTION_LIABILITY_SHARE_BPS,
): Santim | null {
  if (!Number.isSafeInteger(shareBps) || shareBps < 0 || shareBps > 10_000) {
    throw new RangeError(`factory liability share must be an integer 0..10000 (got ${shareBps})`);
  }
  const cap = limits.maxSelectionLiability;
  if (cap === null || !factory) return cap;
  return (cap * BigInt(shareBps)) / 10_000n;
}

function isTighter(a: LiabilityBreach, b: LiabilityBreach): boolean {
  if (a.headroom !== b.headroom) return a.headroom < b.headroom;
  if (a.scope !== b.scope) return a.scope === 'selection';
  return a.id < b.id;
}

/**
 * The largest stake in [minStake, maxStake] whose payout is at most `headroom`, or null when
 * even the minimum stake pays too much. `payoutOf` must not decrease as the stake grows (true of
 * quoteBet: the payout is the stake times fixed odds, rounded down, plus a bonus, capped).
 * The answer is rounded down to whole birr when that still reaches `minStake`, so a player is
 * offered "up to 40 ETB" rather than "39.87 ETB".
 */
export function largestStakeWithin(input: {
  headroom: Santim;
  minStake: Santim;
  maxStake: Santim;
  payoutOf: (stake: Santim) => Santim;
}): Santim | null {
  const { headroom, minStake, maxStake, payoutOf } = input;
  if (minStake > maxStake || payoutOf(minStake) > headroom) return null;
  let low = minStake; // always fits
  let high = maxStake;
  while (low < high) {
    const mid = low + (high - low + 1n) / 2n;
    if (payoutOf(mid) <= headroom) low = mid;
    else high = mid - 1n;
  }
  const whole = (low / SANTIM_PER_BIRR) * SANTIM_PER_BIRR;
  return whole >= minStake ? whole : low;
}

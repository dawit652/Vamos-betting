import { FACTORY_MARKETS, type FactoryMarginClass } from './market-factory';
import { isFactoryOnlyMarketType } from './market-resolve';
import type { Santim } from './money';
import { FACTORY_SELECTION_LIABILITY_SHARE_BPS } from './risk';

/**
 * Margins and limits per market family, and the weekly job that defends them (plan task 2.5,
 * docs/plans/hulusport-parity-plan.md 4.1 "Margin by family" and "Self-defending margins").
 *
 * A family is one market type of the market factory that only the factory prices (`h1_ou`,
 * `htft`, ...; today's nine types are priced as before and are not families). Pure: no I/O.
 * Money is bigint santim; margins are integer basis points of overround.
 */

/** The largest margin a market may carry (checkedMarginBps in @vamos/feed). */
export const MAX_FAMILY_MARGIN_BPS = 10_000;

/** Default margin per class of factory market: 6% main, 7% close derivatives, 12% long. */
export const DEFAULT_FAMILY_MARGIN_BPS: Readonly<Record<FactoryMarginClass, number>> =
  Object.freeze({ main: 600, derivative: 700, long: 1200 });

/** The settings `market_families` (editable in the back office, audited). */
export interface MarketFamilySettings {
  /** Margin per class of factory market, in basis points (0..10000). */
  marginBps: Record<FactoryMarginClass, number>;
  /** Margin of one family (a factory-only market type), winning over its class. */
  typeMarginBps: Record<string, number>;
  /** Factory selections' liability cap as a share of the selection cap, in bps (0..10000). */
  factoryLiabilityShareBps: number;
  /** The weekly job judges a week of a family only when its settled stakes reach this (santim). */
  minWeeklyStake: Santim;
  /**
   * Plan item P-5 (task 2.2, A11): the share of a match's goals priced into the first half of the
   * factory's families, 0.3..0.7 in steps of 0.001; null (the default) keeps the time-based split.
   * The history test measured 0.447 on 13,949 matches.
   */
  firstHalfShare: number | null;
  /**
   * Plan item P-4: the Dixon-Coles rho of the families' full-time grid, -0.2..0 in steps of 0.001
   * (negative raises 0-0 and 1-1); null (the default) leaves the independent grid.
   */
  drawCorrection: number | null;
}

/** 100,000 ETB of settled single stakes a week: below that one week says little about a margin. */
export const DEFAULT_FAMILY_MIN_WEEKLY_STAKE: Santim = 10_000_000n;

/** Today's behaviour exactly: the factory's class margins, no overrides, a quarter of the cap. */
export const DEFAULT_MARKET_FAMILIES: MarketFamilySettings = Object.freeze({
  marginBps: { ...DEFAULT_FAMILY_MARGIN_BPS },
  typeMarginBps: {},
  factoryLiabilityShareBps: FACTORY_SELECTION_LIABILITY_SHARE_BPS,
  minWeeklyStake: DEFAULT_FAMILY_MIN_WEEKLY_STAKE,
  firstHalfShare: null,
  drawCorrection: null,
});

/** Bounds of the two pricing switches (MarketFamilySettings). */
export const FIRST_HALF_SHARE_RANGE = Object.freeze({ min: 0.3, max: 0.7 });
export const DRAW_CORRECTION_RANGE = Object.freeze({ min: -0.2, max: 0 });

/** A switch value: null, or a number within [min, max] with at most three decimals. */
function switchValue(
  value: unknown,
  range: { min: number; max: number },
): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < range.min || value > range.max) return undefined;
  return Math.round(value * 1000) === value * 1000 ? value : undefined;
}

const MARGIN_CLASSES: readonly FactoryMarginClass[] = ['main', 'derivative', 'long'];

/** Every family: the factory-only market types, in catalogue order. */
export const MARKET_FAMILIES: readonly string[] = Object.freeze([
  ...new Set(FACTORY_MARKETS.map((m) => m.type).filter(isFactoryOnlyMarketType)),
]);

const FAMILY_CLASS: ReadonlyMap<string, FactoryMarginClass> = new Map(
  FACTORY_MARKETS.filter((m) => isFactoryOnlyMarketType(m.type)).map((m) => [
    m.type,
    m.marginClass,
  ]),
);

/** True for a family key (a factory-only market type). */
export function isMarketFamily(type: string): boolean {
  return FAMILY_CLASS.has(type);
}

/** The margin class of a family (every market of one type shares its class). */
export function familyMarginClass(type: string): FactoryMarginClass {
  const marginClass = FAMILY_CLASS.get(type);
  if (marginClass === undefined) throw new RangeError(`unknown market family: "${type}"`);
  return marginClass;
}

// ------------------------------------------------------------------ validation

export type MarketFamiliesParse =
  { ok: true; value: MarketFamilySettings } | { ok: false; issues: string[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBps = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000;

/** A santim amount as stored (decimal string), a safe integer or a bigint; null when it is none. */
function santimOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

/**
 * Validates and normalises a whole `market_families` value (no defaults are filled in: the
 * caller merges the stored fields over DEFAULT_MARKET_FAMILIES first). Margins are integers
 * 0..10000 bps, as checkedMarginBps takes them; the liability share is 0..10000 bps; a type
 * override must name a family (a factory-only type: an override of today's types would change
 * nothing); the weekly stake floor is a santim amount of at least 0. The overrides come back
 * sorted by type, so equal settings are equal values. Unknown fields are refused.
 */
export function parseMarketFamilies(value: unknown): MarketFamiliesParse {
  const issues: string[] = [];
  if (!isPlainObject(value)) return { ok: false, issues: ['expected an object'] };
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_MARKET_FAMILIES, key)) issues.push(`${key}: unknown field`);
  }
  const marginBps = { ...DEFAULT_FAMILY_MARGIN_BPS };
  if (!isPlainObject(value.marginBps)) {
    issues.push('marginBps: expected an object with main, derivative and long');
  } else {
    for (const key of Object.keys(value.marginBps)) {
      if (!(MARGIN_CLASSES as readonly string[]).includes(key)) {
        issues.push(`marginBps.${key}: unknown margin class`);
      }
    }
    for (const marginClass of MARGIN_CLASSES) {
      const margin = value.marginBps[marginClass];
      if (isBps(margin)) marginBps[marginClass] = margin;
      else issues.push(`marginBps.${marginClass}: must be an integer from 0 to 10000`);
    }
  }
  const typeMarginBps: Record<string, number> = {};
  if (!isPlainObject(value.typeMarginBps)) {
    issues.push('typeMarginBps: expected an object of market type to margin');
  } else {
    for (const type of Object.keys(value.typeMarginBps).sort()) {
      const margin = value.typeMarginBps[type];
      if (!isMarketFamily(type)) issues.push(`typeMarginBps.${type}: not a factory market family`);
      else if (!isBps(margin)) {
        issues.push(`typeMarginBps.${type}: must be an integer from 0 to 10000`);
      } else typeMarginBps[type] = margin;
    }
  }
  const share = value.factoryLiabilityShareBps;
  if (!isBps(share)) issues.push('factoryLiabilityShareBps: must be an integer from 0 to 10000');
  const floor = santimOf(value.minWeeklyStake);
  if (floor === null) issues.push('minWeeklyStake: expected an amount of santim');
  else if (floor < 0n) issues.push('minWeeklyStake: must not be negative');
  const firstHalfShare = switchValue(value.firstHalfShare, FIRST_HALF_SHARE_RANGE);
  if (firstHalfShare === undefined) {
    issues.push('firstHalfShare: must be null or a number from 0.3 to 0.7 with at most 3 decimals');
  }
  const drawCorrection = switchValue(value.drawCorrection, DRAW_CORRECTION_RANGE);
  if (drawCorrection === undefined) {
    issues.push('drawCorrection: must be null or a number from -0.2 to 0 with at most 3 decimals');
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      marginBps,
      typeMarginBps,
      factoryLiabilityShareBps: share as number,
      minWeeklyStake: floor as bigint,
      firstHalfShare: firstHalfShare ?? null,
      // -0 and 0 are both "no correction": stored as null so equal settings are equal values.
      drawCorrection: drawCorrection === 0 ? null : (drawCorrection ?? null),
    },
  };
}

// ------------------------------------------------------------------ family state

/**
 * Where a family stands with the weekly job:
 * - active: priced; `raisedMarginBps` is null until it has returned once, then the margin it
 *   returned at (it prices at no less). `sinceWeek` is the ISO week it last became active (null:
 *   always was); only weeks after it are judged.
 * - suspended: not priced (its stored markets are suspended by the feed); `raisedMarginBps` is
 *   the margin it would return at.
 * - off: failed again after its one return; never priced again by the job.
 */
export type MarketFamilyStatus = 'active' | 'suspended' | 'off';

export interface MarketFamilyState {
  status: MarketFamilyStatus;
  sinceWeek: string | null;
  raisedMarginBps: number | null;
}

/** A family the job never moved. */
export const ACTIVE_FAMILY: MarketFamilyState = Object.freeze({
  status: 'active',
  sinceWeek: null,
  raisedMarginBps: null,
});

// ------------------------------------------------------------------ pricing plan

/** What factory pricing takes from the settings and the families' states. */
export interface FactoryPricingPlan {
  /** Margin per class (priceFactoryMarkets `marginBps`). */
  marginBps: Record<FactoryMarginClass, number>;
  /** Margin per family where it differs from its class (priceFactoryMarkets `typeMarginBps`). */
  typeMarginBps: Record<string, number>;
  /** Families to price, in catalogue order: all but the suspended and off ones. */
  types: string[];
  /** Families left out (suspended or off), sorted. */
  excluded: string[];
  /** The pricing switches of the settings (priceFactoryMarkets `firstHalfShare`, `drawCorrection`). */
  firstHalfShare: number | null;
  drawCorrection: number | null;
  /**
   * A short stamp of everything above: '' for the defaults (every family active at its class's
   * default margin, no override, both switches off), else 8 hex digits. It goes into the pricing key, so a change of
   * margins or families re-prices each event once.
   */
  tag: string;
}

/** FNV-1a, 32 bits, as 8 hex digits: a stable short stamp (not a security hash). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The pricing of the factory's families from the settings and the job's states: a suspended or
 * off family is not priced; a family that returned prices at its raised margin, or at the
 * settings' margin when that is higher (never cheaper than either).
 */
export function factoryPricingPlan(
  settings: Pick<MarketFamilySettings, 'marginBps' | 'typeMarginBps'> &
    Partial<Pick<MarketFamilySettings, 'firstHalfShare' | 'drawCorrection'>>,
  states: ReadonlyMap<string, MarketFamilyState> = new Map(),
): FactoryPricingPlan {
  const firstHalfShare = settings.firstHalfShare ?? null;
  const drawCorrection = settings.drawCorrection === 0 ? null : (settings.drawCorrection ?? null);
  const marginBps = { ...settings.marginBps };
  const typeMarginBps: Record<string, number> = {};
  const types: string[] = [];
  const excluded: string[] = [];
  for (const type of MARKET_FAMILIES) {
    const state = states.get(type) ?? ACTIVE_FAMILY;
    if (state.status !== 'active') {
      excluded.push(type);
      continue;
    }
    types.push(type);
    const configured = settings.typeMarginBps[type];
    const raised = state.raisedMarginBps;
    if (raised !== null) {
      const base = configured ?? marginBps[familyMarginClass(type)];
      typeMarginBps[type] = Math.min(MAX_FAMILY_MARGIN_BPS, Math.max(raised, base));
    } else if (configured !== undefined) {
      typeMarginBps[type] = configured;
    }
  }
  excluded.sort();
  const overrides = Object.keys(typeMarginBps).sort();
  const isDefault =
    MARGIN_CLASSES.every((c) => marginBps[c] === DEFAULT_FAMILY_MARGIN_BPS[c]) &&
    overrides.length === 0 &&
    excluded.length === 0 &&
    firstHalfShare === null &&
    drawCorrection === null;
  const canonical = [
    MARGIN_CLASSES.map((c) => `${c}=${marginBps[c]}`).join(','),
    overrides.map((t) => `${t}=${typeMarginBps[t]}`).join(','),
    excluded.join(','),
    // Only when set, so the stamps of settings without the switches stay as they were.
    ...(firstHalfShare === null ? [] : [`fhs=${firstHalfShare}`]),
    ...(drawCorrection === null ? [] : [`rho=${drawCorrection}`]),
  ].join(';');
  return {
    marginBps,
    typeMarginBps,
    types,
    excluded,
    firstHalfShare,
    drawCorrection,
    tag: isDefault ? '' : fnv1a(canonical),
  };
}

/** The margin a family is priced at under a plan (its override, else its class's). */
export function familyMarginBps(plan: FactoryPricingPlan, type: string): number {
  return plan.typeMarginBps[type] ?? plan.marginBps[familyMarginClass(type)];
}

// ------------------------------------------------------------------ the weekly decision

/** Weeks in a row a family must keep too little before the job suspends it. */
export const FAMILY_SUSPEND_AFTER_WEEKS = 3;
/** A family returns once, this much dearer (two points of margin). */
export const FAMILY_RETURN_RAISE_BPS = 200;

/** One ISO week of a family's settled bets. */
export interface FamilyWeek {
  /** ISO week, `YYYY-Www`. */
  week: string;
  /** Stakes of the settled bets (santim, at least 0). */
  stakes: Santim;
  /** Stakes minus gross payouts (santim; negative when the house lost). */
  kept: Santim;
  /** The margin charged that week (bps of overround). */
  marginBps: number;
}

export type FamilyMove = 'keep' | 'suspend' | 'stay_suspended' | 'return' | 'off' | 'stay_off';

export interface FamilyDecision {
  family: string;
  move: FamilyMove;
  /** The state after the move (the same as before for keep, stay_suspended and stay_off). */
  next: MarketFamilyState;
  /** Why, in one plain sentence. */
  reason: string;
}

export interface FamilyDecisionInput {
  family: string;
  state: MarketFamilyState;
  /** The ISO week being decided (the last complete week). */
  week: string;
  /** One entry per week, oldest first, consecutive, zero-filled, ending at `week`. */
  weeks: readonly FamilyWeek[];
  /** A week below this stake volume is never judged (settings minWeeklyStake). */
  minWeeklyStake: Santim;
  /**
   * The history test passed at the raised margin. The job passes true only when such a check
   * exists and passed; without one a suspended family stays suspended.
   */
  historyTestPassed: boolean;
}

const WEEK_RE = /^\d{4}-W\d{2}$/;

/**
 * A week kept too little: its stakes reach the floor and the money kept is below what the margin
 * charged should keep. A book with overround m (bps) keeps m / (10000 + m) of its stakes on fair
 * odds, so the week is short when kept × (10000 + m) < stakes × m (bigint, no rounding).
 */
export function keptTooLittle(week: FamilyWeek, minWeeklyStake: Santim): boolean {
  if (week.stakes < minWeeklyStake || week.stakes <= 0n) return false;
  const m = BigInt(week.marginBps);
  return week.kept * (10_000n + m) < week.stakes * m;
}

/**
 * The weekly job's decision for one family (plan 4.1, "Self-defending margins, with no review"):
 * - active, never returned: suspended when each of the last FAMILY_SUSPEND_AFTER_WEEKS weeks since
 *   it became active kept too little (keptTooLittle, so every one of them reached the volume
 *   floor); it would return at the last week's margin + FAMILY_RETURN_RAISE_BPS (at most 10000);
 * - active after its one return: the same test sends it off for good;
 * - suspended: returns at its raised margin only when `historyTestPassed`, else stays suspended;
 * - off: stays off.
 * Deterministic; every move carries its reason.
 */
export function familyDecision(input: FamilyDecisionInput): FamilyDecision {
  const { family, state, week, weeks, minWeeklyStake } = input;
  if (!WEEK_RE.test(week)) throw new RangeError(`week must be an ISO week, got "${week}"`);
  for (let i = 0; i < weeks.length; i += 1) {
    const w = weeks[i]!;
    if (!WEEK_RE.test(w.week)) throw new RangeError(`week must be an ISO week, got "${w.week}"`);
    if (i > 0 && !(weeks[i - 1]!.week < w.week)) {
      throw new RangeError('weeks must be in strictly ascending order');
    }
    if (w.stakes < 0n) throw new RangeError('stakes must not be negative');
    if (!Number.isSafeInteger(w.marginBps) || w.marginBps < 0 || w.marginBps > 10_000) {
      throw new RangeError('marginBps must be an integer 0..10000');
    }
  }
  if (weeks.length > 0 && weeks[weeks.length - 1]!.week !== week) {
    throw new RangeError('weeks must end at the week being decided');
  }
  const same = (move: FamilyMove, reason: string): FamilyDecision => ({
    family,
    move,
    next: { ...state },
    reason,
  });

  if (state.status === 'off') {
    return same(
      'stay_off',
      `off since ${state.sinceWeek ?? 'an earlier week'}: it kept too little again after its one return`,
    );
  }
  if (state.status === 'suspended') {
    const raised = state.raisedMarginBps ?? 0;
    if (!input.historyTestPassed) {
      return same(
        'stay_suspended',
        `suspended since ${state.sinceWeek ?? 'an earlier week'}; no passed history test at ${raised} bps exists, so it stays suspended`,
      );
    }
    return {
      family,
      move: 'return',
      next: { status: 'active', sinceWeek: week, raisedMarginBps: raised },
      reason: `returns once at ${raised} bps: the history test passed at that margin`,
    };
  }

  const since = state.sinceWeek;
  const judged = weeks.filter((w) => since === null || w.week > since);
  const window = judged.slice(-FAMILY_SUSPEND_AFTER_WEEKS);
  if (window.length < FAMILY_SUSPEND_AFTER_WEEKS) {
    return same(
      'keep',
      `${window.length} of ${FAMILY_SUSPEND_AFTER_WEEKS} weeks to judge${since === null ? '' : ` since ${since}`}`,
    );
  }
  const thin = window.find((w) => w.stakes < minWeeklyStake || w.stakes <= 0n);
  if (thin !== undefined) {
    return same(
      'keep',
      `${thin.week} had ${thin.stakes} santim of stakes, under the floor of ${minWeeklyStake}`,
    );
  }
  const fine = window.find((w) => !keptTooLittle(w, minWeeklyStake));
  if (fine !== undefined) {
    return same('keep', `${fine.week} kept what its margin of ${fine.marginBps} bps should keep`);
  }
  const last = window[window.length - 1]!;
  const weeksText = window.map((w) => w.week).join(', ');
  if (state.raisedMarginBps !== null) {
    return {
      family,
      move: 'off',
      next: { status: 'off', sinceWeek: week, raisedMarginBps: state.raisedMarginBps },
      reason: `kept less than its margin of ${last.marginBps} bps should keep in ${weeksText}, after its one return: off for good`,
    };
  }
  const raised = Math.min(MAX_FAMILY_MARGIN_BPS, last.marginBps + FAMILY_RETURN_RAISE_BPS);
  return {
    family,
    move: 'suspend',
    next: { status: 'suspended', sinceWeek: week, raisedMarginBps: raised },
    reason: `kept less than its margin of ${last.marginBps} bps should keep in ${weeksText}: suspended; it may return once at ${raised} bps`,
  };
}

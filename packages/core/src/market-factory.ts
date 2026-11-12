import { CORRECT_SCORE_SELECTIONS, type ResolutionInput, type SelectionResult } from './markets';

/**
 * The market factory (docs/plans/hulusport-parity-plan.md section 4.1, task 2.1).
 *
 * Every football market is described ONCE, as a rule that names the winning
 * selections for a score. The same rule does both jobs:
 *
 * - **Price:** add up the model's probability of every score where a
 *   selection wins ({@link fairBook}).
 * - **Settle:** apply the rule to the real half-time and 90-minute score
 *   ({@link resolveFactorySelection}).
 *
 * A price and its settlement therefore cannot disagree, and a new market is
 * one small rule plus its tests.
 *
 * Scope: Tier A only. Every market settles from the 90-minute score and, where
 * it needs one, the half-time score (the second half is their difference).
 * Outcomes are whole: a selection wins or loses, or the whole market is void
 * (a push on a whole handicap or total line, a draw in draw no bet). Quarter
 * lines (Tier Q) need half-won and half-lost settlement and are task 2.6.
 *
 * Today's football market types ('1x2', 'dc', 'ou', 'ah', 'eh', 'btts', 'dnb',
 * 'ht_1x2', 'cs') keep their codes, line formats and selection codes; the tests
 * check that the factory settles every one of their selections exactly as
 * `resolveSelection` does. Market names here are English working names; the
 * player-facing labels in four languages belong to the match page (task 2.4).
 *
 * Selections that no score can produce (for example "home leads at half time,
 * away wins, under 2.5 goals") are removed when the catalogue is built, so
 * every listed selection can both win and lose.
 */

/** Goals of the two sides over one period. */
export interface Goals {
  readonly home: number;
  readonly away: number;
}

/**
 * What a market is settled on: the 90 minutes ('ft'), the first half ('h1'),
 * the second half ('h2'), or both halves together ('halves').
 */
export type FactoryBasis = 'ft' | 'h1' | 'h2' | 'halves';

export const FACTORY_GROUPS = [
  'full_time',
  'full_time_combos',
  'first_half',
  'second_half',
  'teams',
  'halves',
] as const;
export type FactoryGroup = (typeof FACTORY_GROUPS)[number];

/**
 * Margin family hint for task 2.5: 'main' (1X2, totals, handicaps; 5 to 6%),
 * 'derivative' (close derivatives; 7%), 'long' (correct scores and long
 * combinations; 10 to 15%).
 */
export type FactoryMarginClass = 'main' | 'derivative' | 'long';

/** The winning selections of a market for one score, or 'void' when the whole market is void. */
export type FactoryOutcome = readonly string[] | 'void';

interface FactoryMarketCommon {
  /** Market type code: one of today's codes, or a factory code such as 'h1_ou'. */
  readonly type: string;
  /** Canonical line text ('2.5', '-1', '1-3'), or null for a market without a line. */
  readonly line: string | null;
  readonly group: FactoryGroup;
  /** English working name of the market type. */
  readonly name: string;
  readonly marginClass: FactoryMarginClass;
  /** How many selections win on every score that does not void the market (2 for double chance). */
  readonly winners: number;
  /** Selection codes in display order. */
  readonly selections: readonly string[];
}

/** A market settled on one period's goals. */
export interface FactoryPeriodMarket extends FactoryMarketCommon {
  readonly basis: 'ft' | 'h1' | 'h2';
  readonly outcome: (goals: Goals) => FactoryOutcome;
}

/** A market settled on both halves (the 90 minutes is their sum). */
export interface FactoryHalvesMarket extends FactoryMarketCommon {
  readonly basis: 'halves';
  readonly outcome: (firstHalf: Goals, secondHalf: Goals) => FactoryOutcome;
}

export type FactoryMarket = FactoryPeriodMarket | FactoryHalvesMarket;

// ---------------------------------------------------------------------------
// Small helpers

type Result = '1' | 'X' | '2';

function resultOf(goals: Goals): Result {
  if (goals.home > goals.away) return '1';
  return goals.home === goals.away ? 'X' : '2';
}

function sum(a: Goals, b: Goals): Goals {
  return { home: a.home + b.home, away: a.away + b.away };
}

function total(goals: Goals): number {
  return goals.home + goals.away;
}

/** Frozen single-element outcomes, cached so a rule does not allocate per score. */
const SINGLE = new Map<string, readonly string[]>();
function only(selection: string): readonly string[] {
  let cached = SINGLE.get(selection);
  if (cached === undefined) {
    cached = Object.freeze([selection]);
    SINGLE.set(selection, cached);
  }
  return cached;
}

const PAIR = new Map<string, readonly string[]>();
function both(a: string, b: string): readonly string[] {
  const key = `${a}\u0000${b}`;
  let cached = PAIR.get(key);
  if (cached === undefined) {
    cached = Object.freeze([a, b]);
    PAIR.set(key, cached);
  }
  return cached;
}

function yesNo(condition: boolean): readonly string[] {
  return only(condition ? 'yes' : 'no');
}

const YES_NO = Object.freeze(['yes', 'no']);
const RESULTS = Object.freeze(['1', 'X', '2']);
const OVER_UNDER = Object.freeze(['over', 'under']);
const ODD_EVEN = Object.freeze(['odd', 'even']);
const HALF_COMPARISON = Object.freeze(['1st', '2nd', 'equal']);

/** The double-chance selections that win for each result. */
const DOUBLE_CHANCE_WINNERS: Readonly<Record<Result, readonly string[]>> = Object.freeze({
  '1': both('1X', '12'),
  X: both('1X', 'X2'),
  '2': both('12', 'X2'),
});
const DOUBLE_CHANCE = Object.freeze(['1X', '12', 'X2']);

/** Half-point lines from `from` to `to`, as canonical text ('0.5', '1.5', ...). */
function halfLines(from: number, to: number): string[] {
  const lines: string[] = [];
  for (let value = from; value <= to + 1e-9; value += 1) lines.push(String(value));
  return lines;
}

/** Asian handicap lines of the home side: half and whole lines up to `max` either way, not 0. */
function handicapLines(max: number): string[] {
  const lines: string[] = [];
  for (let tenths = -max * 10; tenths <= max * 10; tenths += 5) {
    if (tenths !== 0) lines.push(String(tenths / 10));
  }
  return lines;
}

/** Whole, non-zero three-way handicap lines up to `max` either way. */
function wholeLines(max: number): string[] {
  const lines: string[] = [];
  for (let value = -max; value <= max; value++) if (value !== 0) lines.push(String(value));
  return lines;
}

// ---------------------------------------------------------------------------
// Family builders

interface FamilyBase {
  type: string;
  group: FactoryGroup;
  name: string;
  marginClass: FactoryMarginClass;
  /** Winning selections per non-void score; default 1. */
  winners?: number;
  /** Lines offered; omitted for a market without a line. */
  lines?: readonly string[];
  /** Candidate selections; unreachable ones are removed when the catalogue is built. */
  selections: readonly string[] | ((line: string | null) => readonly string[]);
}

interface PeriodFamily extends FamilyBase {
  basis: 'ft' | 'h1' | 'h2';
  rule: (line: string | null) => (goals: Goals) => FactoryOutcome;
}

interface HalvesFamily extends FamilyBase {
  basis: 'halves';
  rule: (line: string | null) => (firstHalf: Goals, secondHalf: Goals) => FactoryOutcome;
}

type Family = PeriodFamily | HalvesFamily;

/** Highest goals per side and period enumerated when pruning unreachable selections. */
const REACH_PERIOD_GOALS = 12;
const REACH_HALF_GOALS = 6;

function forEachGoals(max: number, visit: (goals: Goals) => void): void {
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) visit({ home, away });
  }
}

/** Every selection that wins for some score (whole outcomes only, so a void never counts). */
function reachableByPeriod(rule: FactoryPeriodMarket['outcome']): Set<string> {
  const reached = new Set<string>();
  forEachGoals(REACH_PERIOD_GOALS, (goals) => noteWinners(reached, rule(goals)));
  return reached;
}

/** As {@link reachableByPeriod}, for a market on both halves. */
function reachableByHalves(rule: FactoryHalvesMarket['outcome']): Set<string> {
  const reached = new Set<string>();
  forEachGoals(REACH_HALF_GOALS, (first) =>
    forEachGoals(REACH_HALF_GOALS, (second) => noteWinners(reached, rule(first, second))),
  );
  return reached;
}

function noteWinners(reached: Set<string>, result: FactoryOutcome): void {
  if (result !== 'void') for (const selection of result) reached.add(selection);
}

function buildFamily(family: Family): FactoryMarket[] {
  const lines: readonly (string | null)[] = family.lines ?? [null];
  return lines.map((line): FactoryMarket => {
    const candidates =
      typeof family.selections === 'function' ? family.selections(line) : family.selections;
    const common = {
      type: family.type,
      line,
      group: family.group,
      name: family.name,
      marginClass: family.marginClass,
      winners: family.winners ?? 1,
    };
    if (family.basis === 'halves') {
      const outcome = family.rule(line);
      const reached = reachableByHalves(outcome);
      return Object.freeze({
        ...common,
        basis: 'halves' as const,
        outcome,
        selections: Object.freeze(candidates.filter((s) => reached.has(s))),
      });
    }
    const outcome = family.rule(line);
    const reached = reachableByPeriod(outcome);
    return Object.freeze({
      ...common,
      basis: family.basis,
      outcome,
      selections: Object.freeze(candidates.filter((s) => reached.has(s))),
    });
  });
}

function lineValue(line: string | null): number {
  if (line === null) throw new RangeError('this market needs a line');
  return Number(line);
}

/** Multigoals ranges ('1-3': one to three goals), parsed once per market. */
function rangeOf(line: string | null): { from: number; to: number } {
  const match = /^(\d+)-(\d+)$/.exec(line ?? '');
  if (match === null) throw new RangeError(`invalid goal range: "${String(line)}"`);
  return { from: Number(match[1]), to: Number(match[2]) };
}

// --- one-period families ------------------------------------------------------

type PeriodBasis = 'ft' | 'h1' | 'h2';

function resultFamily(type: string, basis: PeriodBasis, group: FactoryGroup, name: string) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'main',
    selections: RESULTS,
    rule: () => (g: Goals) => only(resultOf(g)),
  } satisfies PeriodFamily;
}

function doubleChanceFamily(type: string, basis: PeriodBasis, group: FactoryGroup, name: string) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'main',
    winners: 2,
    selections: DOUBLE_CHANCE,
    rule: () => (g: Goals) => DOUBLE_CHANCE_WINNERS[resultOf(g)],
  } satisfies PeriodFamily;
}

function drawNoBetFamily(type: string, basis: PeriodBasis, group: FactoryGroup, name: string) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'main',
    selections: ['1', '2'],
    rule: () => (g: Goals) => {
      const result = resultOf(g);
      return result === 'X' ? 'void' : only(result);
    },
  } satisfies PeriodFamily;
}

type Side = 'home' | 'away' | 'both';

function goalsOf(g: Goals, side: Side): number {
  if (side === 'home') return g.home;
  return side === 'away' ? g.away : g.home + g.away;
}

/** Over/under a half-point line (never a push). */
function overUnderFamily(
  type: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  name: string,
  lines: readonly string[],
  side: Side = 'both',
  marginClass: FactoryMarginClass = 'main',
) {
  return {
    type,
    basis,
    group,
    name,
    marginClass,
    lines,
    selections: OVER_UNDER,
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (g: Goals) => only(goalsOf(g, side) > value ? 'over' : 'under');
    },
  } satisfies PeriodFamily;
}

/** Over/under a whole line: level on the line voids the market (the stake comes back). */
function asianTotalFamily(
  type: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  name: string,
  lines: readonly string[],
) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'derivative',
    lines,
    selections: OVER_UNDER,
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (g: Goals): FactoryOutcome => {
        const goals = total(g);
        if (goals === value) return 'void';
        return only(goals > value ? 'over' : 'under');
      };
    },
  } satisfies PeriodFamily;
}

/** Asian handicap of the home side on a half or whole line; level after the handicap voids. */
function asianHandicapFamily(
  type: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  name: string,
  lines: readonly string[],
) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'main',
    lines,
    selections: ['1', '2'],
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (g: Goals): FactoryOutcome => {
        // Whole or half lines only, so the sum is exact.
        const margin = g.home - g.away + value;
        if (margin === 0) return 'void';
        return only(margin > 0 ? '1' : '2');
      };
    },
  } satisfies PeriodFamily;
}

/** Three-way handicap of the home side on a whole line: 1/X/2 on the adjusted score. */
function threeWayHandicapFamily(
  type: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  name: string,
  lines: readonly string[],
) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'derivative',
    lines,
    selections: RESULTS,
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (g: Goals) => only(resultOf({ home: g.home + value, away: g.away }));
    },
  } satisfies PeriodFamily;
}

function bttsFamily(type: string, basis: PeriodBasis, group: FactoryGroup, name: string) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'main',
    selections: YES_NO,
    rule: () => (g: Goals) => yesNo(g.home > 0 && g.away > 0),
  } satisfies PeriodFamily;
}

/** Correct score on a 0..max grid per side, plus 'other' for any score outside it. */
function correctScoreSelections(max: number): readonly string[] {
  const selections: string[] = [];
  for (let home = 0; home <= max; home++) {
    for (let away = 0; away <= max; away++) selections.push(`${home}-${away}`);
  }
  selections.push('other');
  return Object.freeze(selections);
}

function correctScoreFamily(
  type: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  name: string,
  max: number,
  selections: readonly string[] = correctScoreSelections(max),
) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'long',
    selections,
    rule: () => (g: Goals) =>
      only(g.home <= max && g.away <= max ? `${g.home}-${g.away}` : 'other'),
  } satisfies PeriodFamily;
}

/** Exact goals 0..top-1 and 'top+'. */
function exactGoalsFamily(
  type: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  name: string,
  top: number,
  side: Side = 'both',
) {
  const selections: string[] = [];
  for (let goals = 0; goals < top; goals++) selections.push(String(goals));
  selections.push(`${top}+`);
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'derivative',
    selections: Object.freeze(selections),
    rule: () => (g: Goals) => {
      const goals = goalsOf(g, side);
      return only(goals >= top ? `${top}+` : String(goals));
    },
  } satisfies PeriodFamily;
}

function oddEvenFamily(
  type: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  name: string,
  side: Side = 'both',
) {
  return {
    type,
    basis,
    group,
    name,
    marginClass: 'derivative',
    selections: ODD_EVEN,
    rule: () => (g: Goals) => only(goalsOf(g, side) % 2 === 1 ? 'odd' : 'even'),
  } satisfies PeriodFamily;
}

// --- full-time-only families ---------------------------------------------------

const WINNING_MARGIN = Object.freeze(['1by1', '1by2', '1by3+', 'X', '2by1', '2by2', '2by3+']);
const GOAL_RANGES = Object.freeze(['0-1', '2-3', '4-5', '6+']);
const MULTIGOAL_LINES = Object.freeze([
  '1-2',
  '1-3',
  '1-4',
  '1-5',
  '1-6',
  '2-3',
  '2-4',
  '2-5',
  '2-6',
  '3-4',
  '3-5',
  '3-6',
  '4-5',
  '4-6',
]);

function combine(first: readonly string[], second: readonly string[]): readonly string[] {
  return Object.freeze(first.flatMap((a) => second.map((b) => `${a}&${b}`)));
}

/** The double-chance selections of a result, each joined with `suffix`. */
const DC_JOINED = new Map<string, readonly string[]>();
function doubleChanceWith(result: Result, suffix: string): readonly string[] {
  const key = `${result}&${suffix}`;
  let cached = DC_JOINED.get(key);
  if (cached === undefined) {
    const [a, b] = DOUBLE_CHANCE_WINNERS[result];
    cached = both(`${a}&${suffix}`, `${b}&${suffix}`);
    DC_JOINED.set(key, cached);
  }
  return cached;
}

/** The 1X2 of one period joined with BTTS or over/under of the same period. */
function resultComboFamilies(
  prefix: string,
  basis: PeriodBasis,
  group: FactoryGroup,
  label: string,
) {
  return {
    resultBtts: {
      type: `${prefix}1x2_btts`,
      basis,
      group,
      name: `${label}1X2 and both teams to score`,
      marginClass: 'long',
      selections: combine(RESULTS, YES_NO),
      rule: () => (g: Goals) => only(`${resultOf(g)}&${g.home > 0 && g.away > 0 ? 'yes' : 'no'}`),
    } satisfies PeriodFamily,
    resultTotal: (lines: readonly string[]) =>
      ({
        type: `${prefix}1x2_ou`,
        basis,
        group,
        name: `${label}1X2 and total goals`,
        marginClass: 'long',
        lines,
        selections: combine(RESULTS, OVER_UNDER),
        rule: (line: string | null) => {
          const value = lineValue(line);
          return (g: Goals) => only(`${resultOf(g)}&${total(g) > value ? 'over' : 'under'}`);
        },
      }) satisfies PeriodFamily,
  };
}

const FULL_TIME_FAMILIES: Family[] = [
  resultFamily('1x2', 'ft', 'full_time', 'Match result'),
  doubleChanceFamily('dc', 'ft', 'full_time', 'Double chance'),
  drawNoBetFamily('dnb', 'ft', 'full_time', 'Draw no bet'),
  overUnderFamily('ou', 'ft', 'full_time', 'Total goals', halfLines(0.5, 6.5)),
  asianTotalFamily('asian_total', 'ft', 'full_time', 'Asian total goals', [
    '1',
    '2',
    '3',
    '4',
    '5',
  ]),
  asianHandicapFamily('ah', 'ft', 'full_time', 'Asian handicap', handicapLines(3.5)),
  threeWayHandicapFamily('eh', 'ft', 'full_time', '3-way handicap', wholeLines(3)),
  bttsFamily('btts', 'ft', 'full_time', 'Both teams to score'),
  correctScoreFamily('cs', 'ft', 'full_time', 'Correct score', 4, CORRECT_SCORE_SELECTIONS),
  exactGoalsFamily('exact_goals', 'ft', 'full_time', 'Exact goals', 6),
  oddEvenFamily('odd_even', 'ft', 'full_time', 'Total goals odd/even'),
  {
    type: 'winning_margin',
    basis: 'ft',
    group: 'full_time',
    name: 'Winning margin',
    marginClass: 'derivative',
    selections: WINNING_MARGIN,
    rule: () => (g: Goals) => {
      const diff = g.home - g.away;
      if (diff === 0) return only('X');
      const side = diff > 0 ? '1' : '2';
      const by = Math.abs(diff);
      return only(`${side}by${by >= 3 ? '3+' : String(by)}`);
    },
  },
  {
    type: 'goal_range',
    basis: 'ft',
    group: 'full_time',
    name: 'Goal range',
    marginClass: 'derivative',
    selections: GOAL_RANGES,
    rule: () => (g: Goals) => {
      const goals = total(g);
      if (goals >= 6) return only('6+');
      const from = goals - (goals % 2);
      return only(`${from}-${from + 1}`);
    },
  },
  {
    type: 'multigoals',
    basis: 'ft',
    group: 'full_time',
    name: 'Multigoals',
    marginClass: 'derivative',
    lines: MULTIGOAL_LINES,
    selections: YES_NO,
    rule: (line: string | null) => {
      const { from, to } = rangeOf(line);
      return (g: Goals) => {
        const goals = total(g);
        return yesNo(goals >= from && goals <= to);
      };
    },
  },
];

const FT_COMBOS = resultComboFamilies('ft_', 'ft', 'full_time_combos', '');

const FULL_TIME_COMBO_FAMILIES: Family[] = [
  FT_COMBOS.resultBtts,
  FT_COMBOS.resultTotal(['1.5', '2.5', '3.5', '4.5']),
  {
    type: 'ft_dc_btts',
    basis: 'ft',
    group: 'full_time_combos',
    name: 'Double chance and both teams to score',
    marginClass: 'long',
    winners: 2,
    selections: combine(DOUBLE_CHANCE, YES_NO),
    rule: () => (g: Goals) =>
      doubleChanceWith(resultOf(g), g.home > 0 && g.away > 0 ? 'yes' : 'no'),
  },
  {
    type: 'ft_dc_ou',
    basis: 'ft',
    group: 'full_time_combos',
    name: 'Double chance and total goals',
    marginClass: 'long',
    winners: 2,
    lines: ['1.5', '2.5', '3.5', '4.5'],
    selections: combine(DOUBLE_CHANCE, OVER_UNDER),
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (g: Goals) => doubleChanceWith(resultOf(g), total(g) > value ? 'over' : 'under');
    },
  },
  {
    type: 'ft_btts_ou',
    basis: 'ft',
    group: 'full_time_combos',
    name: 'Both teams to score and total goals',
    marginClass: 'long',
    lines: ['2.5', '3.5'],
    selections: combine(YES_NO, OVER_UNDER),
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (g: Goals) =>
        only(`${g.home > 0 && g.away > 0 ? 'yes' : 'no'}&${total(g) > value ? 'over' : 'under'}`);
    },
  },
];

/** The families of one half; the first half keeps today's 'ht_1x2' code for its 1X2. */
function halfFamilies(half: 'h1' | 'h2'): Family[] {
  const group: FactoryGroup = half === 'h1' ? 'first_half' : 'second_half';
  const label = half === 'h1' ? '1st half ' : '2nd half ';
  const combos = resultComboFamilies(`${half}_`, half, group, label);
  return [
    resultFamily(half === 'h1' ? 'ht_1x2' : 'h2_1x2', half, group, `${label}result`),
    doubleChanceFamily(`${half}_dc`, half, group, `${label}double chance`),
    drawNoBetFamily(`${half}_dnb`, half, group, `${label}draw no bet`),
    overUnderFamily(`${half}_ou`, half, group, `${label}total goals`, halfLines(0.5, 3.5)),
    asianTotalFamily(`${half}_asian_total`, half, group, `${label}Asian total goals`, ['1', '2']),
    asianHandicapFamily(`${half}_ah`, half, group, `${label}Asian handicap`, handicapLines(1.5)),
    threeWayHandicapFamily(`${half}_eh`, half, group, `${label}3-way handicap`, wholeLines(1)),
    bttsFamily(`${half}_btts`, half, group, `${label}both teams to score`),
    correctScoreFamily(`${half}_cs`, half, group, `${label}correct score`, 2),
    exactGoalsFamily(`${half}_exact_goals`, half, group, `${label}exact goals`, 3),
    oddEvenFamily(`${half}_odd_even`, half, group, `${label}total goals odd/even`),
    combos.resultBtts,
    combos.resultTotal(['1.5']),
  ];
}

// --- team families ---------------------------------------------------------------

function teamFamilies(side: 'home' | 'away'): Family[] {
  const label = side === 'home' ? 'Home' : 'Away';
  const other: 'home' | 'away' = side === 'home' ? 'away' : 'home';
  const winner: Result = side === 'home' ? '1' : '2';
  const noBetSelections = side === 'home' ? ['X', '2'] : ['1', 'X'];
  const scored = (g: Goals) => (side === 'home' ? g.home : g.away);
  const conceded = (g: Goals) => (side === 'home' ? g.away : g.home);
  return [
    overUnderFamily(`${side}_ou`, 'ft', 'teams', `${label} total goals`, halfLines(0.5, 3.5), side),
    exactGoalsFamily(`${side}_exact_goals`, 'ft', 'teams', `${label} exact goals`, 3, side),
    oddEvenFamily(`${side}_odd_even`, 'ft', 'teams', `${label} goals odd/even`, side),
    {
      type: `${side}_clean_sheet`,
      basis: 'ft',
      group: 'teams',
      name: `${label} clean sheet`,
      marginClass: 'derivative',
      selections: YES_NO,
      rule: () => (g: Goals) => yesNo(conceded(g) === 0),
    },
    {
      type: `${side}_win_to_nil`,
      basis: 'ft',
      group: 'teams',
      name: `${label} to win to nil`,
      marginClass: 'derivative',
      selections: YES_NO,
      rule: () => (g: Goals) => yesNo(scored(g) > 0 && conceded(g) === 0),
    },
    {
      type: `${side}_no_bet`,
      basis: 'ft',
      group: 'teams',
      name: `${label} no bet`,
      marginClass: 'derivative',
      selections: noBetSelections,
      rule:
        () =>
        (g: Goals): FactoryOutcome => {
          const result = resultOf(g);
          return result === winner ? 'void' : only(result);
        },
    },
    overUnderFamily(
      `${side}_h1_ou`,
      'h1',
      'teams',
      `${label} 1st half total goals`,
      ['0.5', '1.5'],
      side,
      'derivative',
    ),
    overUnderFamily(
      `${side}_h2_ou`,
      'h2',
      'teams',
      `${label} 2nd half total goals`,
      ['0.5', '1.5'],
      side,
      'derivative',
    ),
    {
      type: `${side}_score_both_halves`,
      basis: 'halves',
      group: 'teams',
      name: `${label} to score in both halves`,
      marginClass: 'derivative',
      selections: YES_NO,
      rule: () => (first: Goals, second: Goals) => yesNo(scored(first) > 0 && scored(second) > 0),
    },
    {
      type: `${side}_highest_scoring_half`,
      basis: 'halves',
      group: 'teams',
      name: `${label} highest scoring half`,
      marginClass: 'derivative',
      selections: HALF_COMPARISON,
      rule: () => (first: Goals, second: Goals) => {
        const a = scored(first);
        const b = scored(second);
        return only(a > b ? '1st' : a < b ? '2nd' : 'equal');
      },
    },
    {
      type: `${side}_win_both_halves`,
      basis: 'halves',
      group: 'teams',
      name: `${label} to win both halves`,
      marginClass: 'derivative',
      selections: YES_NO,
      rule: () => (first: Goals, second: Goals) =>
        yesNo(resultOf(first) === winner && resultOf(second) === winner),
    },
    {
      type: `${side}_win_either_half`,
      basis: 'halves',
      group: 'teams',
      name: `${label} to win either half`,
      marginClass: 'derivative',
      selections: YES_NO,
      rule: () => (first: Goals, second: Goals) =>
        yesNo(resultOf(first) === winner || resultOf(second) === winner),
    },
    {
      type: `${side}_multigoals`,
      basis: 'ft',
      group: 'teams',
      name: `${label} multigoals`,
      marginClass: 'derivative',
      lines: ['1-2', '1-3', '2-3'],
      selections: YES_NO,
      rule: (line: string | null) => {
        const { from, to } = rangeOf(line);
        return (g: Goals) => yesNo(scored(g) >= from && scored(g) <= to);
      },
    },
  ].map((family) => {
    // `other` is used by the rules through `conceded`; keep the reference explicit for readers.
    void other;
    return family as Family;
  });
}

// --- across the halves ---------------------------------------------------------------

const HT_FT = combine(RESULTS, RESULTS).map((s) => s.replace('&', '/'));

const HALVES_FAMILIES: Family[] = [
  {
    type: 'htft',
    basis: 'halves',
    group: 'halves',
    name: 'Half time / full time',
    marginClass: 'long',
    selections: Object.freeze(HT_FT),
    rule: () => (first: Goals, second: Goals) =>
      only(`${resultOf(first)}/${resultOf(sum(first, second))}`),
  },
  {
    type: 'htft_ou',
    basis: 'halves',
    group: 'halves',
    name: 'Half time / full time and total goals',
    marginClass: 'long',
    lines: ['2.5', '3.5'],
    selections: Object.freeze(HT_FT.flatMap((s) => [`${s}&over`, `${s}&under`])),
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (first: Goals, second: Goals) => {
        const full = sum(first, second);
        return only(
          `${resultOf(first)}/${resultOf(full)}&${total(full) > value ? 'over' : 'under'}`,
        );
      };
    },
  },
  {
    type: 'h1_h2_1x2',
    basis: 'halves',
    group: 'halves',
    name: '1st half result / 2nd half result',
    marginClass: 'long',
    selections: Object.freeze(HT_FT),
    rule: () => (first: Goals, second: Goals) => only(`${resultOf(first)}/${resultOf(second)}`),
  },
  {
    type: 'highest_scoring_half',
    basis: 'halves',
    group: 'halves',
    name: 'Highest scoring half',
    marginClass: 'derivative',
    selections: HALF_COMPARISON,
    rule: () => (first: Goals, second: Goals) => {
      const a = total(first);
      const b = total(second);
      return only(a > b ? '1st' : a < b ? '2nd' : 'equal');
    },
  },
  {
    type: 'btts_both_halves',
    basis: 'halves',
    group: 'halves',
    name: 'Both teams to score in both halves',
    marginClass: 'derivative',
    selections: YES_NO,
    rule: () => (first: Goals, second: Goals) =>
      yesNo(first.home > 0 && first.away > 0 && second.home > 0 && second.away > 0),
  },
  {
    type: 'goal_both_halves',
    basis: 'halves',
    group: 'halves',
    name: 'A goal in both halves',
    marginClass: 'derivative',
    selections: YES_NO,
    rule: () => (first: Goals, second: Goals) => yesNo(total(first) > 0 && total(second) > 0),
  },
  {
    type: 'both_halves_ou',
    basis: 'halves',
    group: 'halves',
    name: 'Both halves over',
    marginClass: 'derivative',
    lines: ['0.5', '1.5'],
    selections: YES_NO,
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (first: Goals, second: Goals) => yesNo(total(first) > value && total(second) > value);
    },
  },
  {
    type: 'h1_h2_ou',
    basis: 'halves',
    group: 'halves',
    name: '1st half total / 2nd half total',
    marginClass: 'derivative',
    lines: ['0.5', '1.5'],
    selections: combine(OVER_UNDER, OVER_UNDER).map((s) => s.replace('&', '/')),
    rule: (line: string | null) => {
      const value = lineValue(line);
      return (first: Goals, second: Goals) =>
        only(
          `${total(first) > value ? 'over' : 'under'}/${total(second) > value ? 'over' : 'under'}`,
        );
    },
  },
];

// ---------------------------------------------------------------------------
// The catalogue

/** Every market the factory can define, in display order (full time first). */
export const FACTORY_MARKETS: readonly FactoryMarket[] = Object.freeze(
  [
    ...FULL_TIME_FAMILIES,
    ...FULL_TIME_COMBO_FAMILIES,
    ...halfFamilies('h1'),
    ...halfFamilies('h2'),
    ...teamFamilies('home'),
    ...teamFamilies('away'),
    ...HALVES_FAMILIES,
  ].flatMap(buildFamily),
);

/** Today's football market types: their codes, lines and selections are stored and must not change. */
export const LEGACY_FOOTBALL_TYPES: readonly string[] = Object.freeze([
  '1x2',
  'dc',
  'ou',
  'ah',
  'eh',
  'btts',
  'dnb',
  'ht_1x2',
  'cs',
]);

const NUMERIC_LINE = /^[+-]?\d{1,3}(\.\d{1,2})?$/;

/** The canonical text of a factory line: numbers as `String(Number(x))` ('+1' → '1', '02.5' → '2.5'). */
export function canonicalFactoryLine(line: string | null | undefined): string | null {
  if (line === null || line === undefined) return null;
  if (typeof line !== 'string') throw new RangeError(`invalid line: ${String(line)}`);
  if (NUMERIC_LINE.test(line)) return String(Number(line) + 0); // + 0 turns -0 into 0
  return line;
}

function keyOf(type: string, line: string | null): string {
  return line === null ? type : `${type}:${line}`;
}

const BY_KEY: ReadonlyMap<string, FactoryMarket> = new Map(
  FACTORY_MARKETS.map((market) => [keyOf(market.type, market.line), market]),
);

/** The factory market of a type and line, or undefined when the factory does not define it. */
export function findFactoryMarket(type: string, line?: string | null): FactoryMarket | undefined {
  let canonical: string | null;
  try {
    canonical = canonicalFactoryLine(line);
  } catch {
    return undefined;
  }
  return BY_KEY.get(keyOf(type, canonical));
}

/** Like {@link findFactoryMarket}, but throws a RangeError for a market the factory does not define. */
export function factoryMarket(type: string, line?: string | null): FactoryMarket {
  const market = findFactoryMarket(type, line);
  if (market === undefined) {
    throw new RangeError(
      `unknown factory market: "${type}"${line === null || line === undefined ? '' : ` line "${line}"`}`,
    );
  }
  return market;
}

// ---------------------------------------------------------------------------
// Settlement

const VOID_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'abandoned', 'postponed']);

function checkedGoal(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid ${what}: ${String(value)}`);
  }
  return value;
}

/**
 * Resolves one selection of a factory market against the event outcome, with
 * the same rule that priced it.
 *
 * - A cancelled, abandoned or postponed event voids every selection (as
 *   `resolveSelection` does).
 * - The score is the 90-minute score; markets on a half or on both halves need
 *   the half-time score (the second half is the difference) and throw a
 *   RangeError without it.
 * - An unknown market or selection, a malformed score, or a half-time score
 *   above the full-time score throws a RangeError.
 */
export function resolveFactorySelection(
  market: { type: string; line?: string | null },
  selection: string,
  input: ResolutionInput,
): SelectionResult {
  const definition = factoryMarket(market.type, market.line);
  if (!definition.selections.includes(selection)) {
    throw new RangeError(
      `invalid selection "${String(selection)}" for market "${keyOf(definition.type, definition.line)}"`,
    );
  }
  const status: string = input.status;
  if (VOID_STATUSES.has(status)) return 'void';
  if (input.status !== 'finished') throw new RangeError(`unknown event status: "${status}"`);
  const score = input.score;
  if (typeof score !== 'object' || score === null) {
    throw new RangeError('a finished event needs a score');
  }
  const full: Goals = {
    home: checkedGoal(score.home, 'home score'),
    away: checkedGoal(score.away, 'away score'),
  };
  const hasHalfTime =
    (score.htHome !== null && score.htHome !== undefined) ||
    (score.htAway !== null && score.htAway !== undefined);
  let first: Goals | null = null;
  if (hasHalfTime) {
    first = {
      home: checkedGoal(score.htHome, 'half-time home score'),
      away: checkedGoal(score.htAway, 'half-time away score'),
    };
    if (first.home > full.home || first.away > full.away) {
      throw new RangeError(
        `half-time score ${first.home}-${first.away} exceeds the full-time score ${full.home}-${full.away}`,
      );
    }
  }
  const outcome = outcomeFor(definition, full, first);
  if (outcome === 'void') return 'void';
  return outcome.includes(selection) ? 'won' : 'lost';
}

function outcomeFor(market: FactoryMarket, full: Goals, first: Goals | null): FactoryOutcome {
  if (market.basis === 'ft') return market.outcome(full);
  if (first === null) {
    throw new RangeError(`the half-time score is required to settle "${market.type}"`);
  }
  const second: Goals = { home: full.home - first.home, away: full.away - first.away };
  switch (market.basis) {
    case 'h1':
      return market.outcome(first);
    case 'h2':
      return market.outcome(second);
    case 'halves':
      return market.outcome(first, second);
    default:
      throw new RangeError(`unknown basis: ${String((market as FactoryMarket).basis)}`);
  }
}

// ---------------------------------------------------------------------------
// Pricing: fair probabilities from the same rule

/** A score grid: grid[h][a] is the probability that home scores h and away a in the period. */
export type ScoreGrid = ReadonlyArray<ReadonlyArray<number>>;

/**
 * The model's score distributions a market can be priced from. `ft` is the
 * 90 minutes; `h1` and `h2` are the halves, taken as independent, so the
 * joint distribution of a 'halves' market is their product.
 */
export interface FactoryScoreGrids {
  readonly ft: ScoreGrid;
  readonly h1: ScoreGrid;
  readonly h2: ScoreGrid;
}

/** The fair book of one factory market. */
export interface FactoryFairBook {
  readonly market: FactoryMarket;
  /**
   * Fair probability of each selection (in `market.selections` order), given
   * that the market is not void, as the whole-line Asian handicap and draw no
   * bet are priced today.
   */
  readonly probabilities: readonly number[];
  /** Probability that the market is void (a push); the stake then comes back. */
  readonly voidProbability: number;
  /** False when the market is (almost) certainly void and cannot be priced. */
  readonly priceable: boolean;
}

/** Below this, a market's non-void mass counts as zero and the market is not priced. */
const MIN_DECISIVE = 1e-12;

/**
 * The fair probabilities of a market's selections: for each score of the
 * market's basis, its probability is added to every selection the market's
 * rule names as a winner. The cells are visited in grid order (home goals,
 * then away goals), so a market with the same rule as today's pricing sums the
 * same numbers in the same order.
 */
export function fairBook(market: FactoryMarket, grids: FactoryScoreGrids): FactoryFairBook {
  const index = new Map(market.selections.map((selection, i) => [selection, i]));
  const sums = market.selections.map(() => 0);
  let voidMass = 0;
  // Summed cell by cell, not as mass − voidMass, which cancels catastrophically when a market
  // is almost certainly void.
  let decisiveMass = 0;
  const add = (outcome: FactoryOutcome, p: number) => {
    if (outcome === 'void') {
      voidMass += p;
      return;
    }
    decisiveMass += p;
    for (const selection of outcome) {
      const i = index.get(selection);
      // Unreachable selections were pruned; a rule naming one would be a bug.
      if (i === undefined) throw new RangeError(`rule of "${market.type}" names "${selection}"`);
      sums[i] = (sums[i] ?? 0) + p;
    }
  };
  if (market.basis === 'halves') {
    const firsts = cellsOf(grids.h1);
    const seconds = cellsOf(grids.h2);
    for (const first of firsts) {
      for (const second of seconds)
        add(market.outcome(first.goals, second.goals), first.p * second.p);
    }
  } else {
    const grid = market.basis === 'ft' ? grids.ft : market.basis === 'h1' ? grids.h1 : grids.h2;
    for (const cell of cellsOf(grid)) add(market.outcome(cell.goals), cell.p);
  }
  // The non-void mass as the sum of the selections' sums (over the winners per score): the same
  // additions as today's pricing makes ('ah', 'dnb': home + away), so their prices do not move.
  const decisive = sums.reduce((a, b) => a + b, 0) / market.winners;
  const mass = decisiveMass + voidMass;
  const priceable = decisive > MIN_DECISIVE;
  const hasVoid = voidMass > 0;
  return {
    market,
    probabilities: sums.map((s) => (priceable ? (hasVoid ? s / decisive : s) : 0)),
    voidProbability: mass > 0 ? voidMass / mass : 0,
    priceable,
  };
}

interface Cell {
  goals: Goals;
  p: number;
}

const CELLS = new WeakMap<ScoreGrid, Cell[]>();

/** The non-zero cells of a grid in row order, cached per grid object. */
function cellsOf(grid: ScoreGrid): Cell[] {
  let cells = CELLS.get(grid);
  if (cells !== undefined) return cells;
  cells = [];
  for (const [home, row] of grid.entries()) {
    for (const [away, p] of row.entries()) {
      if (!Number.isFinite(p) || p < 0)
        throw new RangeError(`invalid probability ${p} at ${home}-${away}`);
      if (p > 0) cells.push({ goals: { home, away }, p });
    }
  }
  CELLS.set(grid, cells);
  return cells;
}

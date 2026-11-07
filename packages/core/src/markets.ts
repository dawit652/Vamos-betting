/**
 * Market catalogue and result resolution, shared by the odds simulator and
 * settlement.
 *
 * NOTE: every Amharic (`am`) name and label in this file is a working
 * translation that is pending review by a native speaker before launch.
 *
 * Total markets ('ou', 'total') only accept half-point lines ("2.5", "215.5"),
 * so a finished match always resolves them to exactly one of over/under and a
 * push (refund) is impossible. Handicap markets take the home side's handicap:
 * 'ah' (Asian, two-way) a half or whole line ("-1.5", "0", "1"), where a level
 * adjusted score on a whole line voids both selections (the stake comes back;
 * quarter lines are not offered); 'eh' (three-way) a non-zero whole line
 * ("-1", "2"), settled 1/X/2 on the adjusted score.
 */

export type SportCode = 'football' | 'basketball' | 'tennis' | 'volleyball';

export type MarketTypeCode =
  '1x2' | 'dc' | 'ou' | 'ah' | 'eh' | 'btts' | 'dnb' | 'ht_1x2' | 'cs' | 'ml' | 'total' | 'winner';

export interface MarketTypeDefinition {
  code: MarketTypeCode;
  /** Owning sport. 'winner' is shared by tennis and volleyball; see SPORT_MARKETS. */
  sport: SportCode;
  name: { en: string; am: string };
  /** True when the market needs a line: a half-point total ("2.5") or a handicap ("-1.5"). */
  hasLine: boolean;
  /** The part of the match the market is settled on. */
  period: 'full_time' | 'half_time';
  /** Display order within the sport, ascending. */
  sortOrder: number;
}

export interface FinalScore {
  home: number;
  away: number;
  /** Half-time score; required only to settle 'ht_1x2'. */
  htHome?: number | null;
  htAway?: number | null;
}

export type ResolutionInput =
  { status: 'finished'; score: FinalScore } | { status: 'cancelled' | 'abandoned' | 'postponed' };

export type SelectionResult = 'won' | 'lost' | 'void';

type Outcome = '1' | 'X' | '2';
type Label = { en: string; am: string };

function defineMarket(definition: MarketTypeDefinition): MarketTypeDefinition {
  return Object.freeze({ ...definition, name: Object.freeze({ ...definition.name }) });
}

function frozenList<T>(...items: T[]): readonly T[] {
  return Object.freeze(items);
}

export const MARKET_TYPES: Readonly<Record<MarketTypeCode, MarketTypeDefinition>> = Object.freeze({
  '1x2': defineMarket({
    code: '1x2',
    sport: 'football',
    name: { en: 'Match Result', am: 'የጨዋታ ውጤት' },
    hasLine: false,
    period: 'full_time',
    sortOrder: 10,
  }),
  dc: defineMarket({
    code: 'dc',
    sport: 'football',
    name: { en: 'Double Chance', am: 'ድርብ ዕድል' },
    hasLine: false,
    period: 'full_time',
    sortOrder: 20,
  }),
  ou: defineMarket({
    code: 'ou',
    sport: 'football',
    name: { en: 'Total Goals Over/Under', am: 'ጠቅላላ ጎል ከ በላይ/በታች' },
    hasLine: true,
    period: 'full_time',
    sortOrder: 30,
  }),
  ah: defineMarket({
    code: 'ah',
    sport: 'football',
    name: { en: 'Asian Handicap', am: 'የእስያ ሃንዲካፕ' },
    hasLine: true,
    period: 'full_time',
    sortOrder: 32,
  }),
  eh: defineMarket({
    code: 'eh',
    sport: 'football',
    name: { en: '3-Way Handicap', am: 'ባለሦስት ውጤት ሃንዲካፕ' },
    hasLine: true,
    period: 'full_time',
    sortOrder: 34,
  }),
  btts: defineMarket({
    code: 'btts',
    sport: 'football',
    name: { en: 'Both Teams To Score', am: 'ሁለቱም ቡድኖች ያገባሉ' },
    hasLine: false,
    period: 'full_time',
    sortOrder: 40,
  }),
  dnb: defineMarket({
    code: 'dnb',
    sport: 'football',
    name: { en: 'Draw No Bet', am: 'አቻ ከሆነ ገንዘብ ይመለሳል' },
    hasLine: false,
    period: 'full_time',
    sortOrder: 50,
  }),
  ht_1x2: defineMarket({
    code: 'ht_1x2',
    sport: 'football',
    name: { en: 'Half-time Result', am: 'የመጀመሪያ አጋማሽ ውጤት' },
    hasLine: false,
    period: 'half_time',
    sortOrder: 60,
  }),
  cs: defineMarket({
    code: 'cs',
    sport: 'football',
    name: { en: 'Correct Score', am: 'ትክክለኛ ውጤት' },
    hasLine: false,
    period: 'full_time',
    sortOrder: 70,
  }),
  ml: defineMarket({
    code: 'ml',
    sport: 'basketball',
    name: { en: 'Winner (incl. overtime)', am: 'አሸናፊ (ተጨማሪ ሰዓትን ጨምሮ)' },
    hasLine: false,
    period: 'full_time',
    sortOrder: 10,
  }),
  total: defineMarket({
    code: 'total',
    sport: 'basketball',
    name: { en: 'Total Points Over/Under', am: 'ጠቅላላ ነጥብ ከ በላይ/በታች' },
    hasLine: true,
    period: 'full_time',
    sortOrder: 20,
  }),
  winner: defineMarket({
    code: 'winner',
    sport: 'tennis',
    name: { en: 'Match Winner', am: 'የጨዋታ አሸናፊ' },
    hasLine: false,
    period: 'full_time',
    sortOrder: 10,
  }),
});

/**
 * Markets offered per sport, in display order. The handicaps ('ah', 'eh') are
 * defined and settle, but are offered only once they are priced and every
 * consumer of lines accepts handicap lines (plan task 2.1, step B).
 */
export const SPORT_MARKETS: Readonly<Record<SportCode, readonly MarketTypeCode[]>> = Object.freeze({
  football: frozenList<MarketTypeCode>('1x2', 'dc', 'ou', 'btts', 'dnb', 'ht_1x2', 'cs'),
  basketball: frozenList<MarketTypeCode>('ml', 'total'),
  tennis: frozenList<MarketTypeCode>('winner'),
  volleyball: frozenList<MarketTypeCode>('winner'),
});

/** Highest goal count per team that has its own correct-score selection. */
const CORRECT_SCORE_MAX_GOALS = 4;
const CORRECT_SCORE_OTHER = 'other';

/**
 * Every 'h-a' score for h, a in 0..4 (25 values, home goals first), then
 * 'other', which wins for any score outside that grid.
 */
export const CORRECT_SCORE_SELECTIONS: readonly string[] = (() => {
  const selections: string[] = [];
  for (let home = 0; home <= CORRECT_SCORE_MAX_GOALS; home++) {
    for (let away = 0; away <= CORRECT_SCORE_MAX_GOALS; away++) {
      selections.push(`${home}-${away}`);
    }
  }
  selections.push(CORRECT_SCORE_OTHER);
  return Object.freeze(selections);
})();

const SELECTIONS_1X2 = frozenList('1', 'X', '2');
const SELECTIONS_TWO_WAY = frozenList('1', '2');
const SELECTIONS_OVER_UNDER = frozenList('over', 'under');

const SELECTIONS: Readonly<Record<MarketTypeCode, readonly string[]>> = Object.freeze({
  '1x2': SELECTIONS_1X2,
  dc: frozenList('1X', '12', 'X2'),
  ou: SELECTIONS_OVER_UNDER,
  ah: SELECTIONS_TWO_WAY,
  eh: SELECTIONS_1X2,
  btts: frozenList('yes', 'no'),
  dnb: SELECTIONS_TWO_WAY,
  ht_1x2: SELECTIONS_1X2,
  cs: CORRECT_SCORE_SELECTIONS,
  ml: SELECTIONS_TWO_WAY,
  total: SELECTIONS_OVER_UNDER,
  winner: SELECTIONS_TWO_WAY,
});

/** The 1X2 outcomes each double-chance selection covers. */
const DOUBLE_CHANCE_COVERS: Readonly<Record<string, readonly Outcome[]>> = Object.freeze({
  '1X': frozenList<Outcome>('1', 'X'),
  '12': frozenList<Outcome>('1', '2'),
  X2: frozenList<Outcome>('X', '2'),
});

const VOID_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'abandoned', 'postponed']);

const LINE_PATTERN = /^\d{1,3}\.5$/;

/**
 * Parses a half-point line ("0.5", "2.5", "215.5") into its numeric value.
 * Whole, quarter and negative lines are rejected with a RangeError.
 */
export function parseLine(line: string): number {
  if (typeof line !== 'string' || !LINE_PATTERN.test(line)) {
    throw new RangeError(`invalid line: "${String(line)}" (expected a half-point line like "2.5")`);
  }
  return Number(line);
}

const HANDICAP_PATTERN = /^[+-]?\d{1,2}(\.5)?$/;

/** Largest handicap offered either way, in goals. */
export const MAX_HANDICAP = 20;

/**
 * Parses a handicap line of the home side, a half or whole number of goals
 * ("-1.5", "+0.5", "0", "2") at most MAX_HANDICAP either way. With
 * `wholeOnly` (the three-way handicap) only non-zero whole lines are valid.
 * Quarter lines ("-0.25") and anything else throw a RangeError.
 */
export function parseHandicap(line: string, options: { wholeOnly?: boolean } = {}): number {
  if (typeof line !== 'string' || !HANDICAP_PATTERN.test(line)) {
    throw new RangeError(
      `invalid handicap: "${String(line)}" (expected a half or whole line like "-1.5" or "1")`,
    );
  }
  const value = Number(line) + 0; // + 0 turns -0 into 0
  if (Math.abs(value) > MAX_HANDICAP) throw new RangeError(`handicap out of range: "${line}"`);
  if (options.wholeOnly === true && (!Number.isInteger(value) || value === 0)) {
    throw new RangeError(`invalid three-way handicap: "${line}" (expected a non-zero whole line)`);
  }
  return value;
}

/** A handicap as a bettor reads it: "+1.5", "-1", "0". */
export function formatHandicap(value: number): string {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Stable key of a market within an event: the type code, plus ":<line>" for
 * line markets ('1x2', 'ou:2.5'). The line is canonicalised ("02.5" → "2.5")
 * so one market always has one key. Throws a RangeError when a line market
 * has no line or a non-line market is given one.
 */
export function marketKey(type: MarketTypeCode, line?: string | null): string {
  const canonical = checkedLine(type, line);
  return canonical === null ? type : `${type}:${canonical}`;
}

/** The valid selection codes of a market type, in display order. */
export function selectionsFor(type: MarketTypeCode): readonly string[] {
  definitionOf(type);
  return SELECTIONS[type];
}

/**
 * Human-readable label of a selection for the bet slip, in English and
 * Amharic. Team names are used as given in both languages.
 */
export function selectionLabel(
  type: MarketTypeCode,
  selection: string,
  teams: { home: string; away: string },
  line?: string | null,
): { en: string; am: string } {
  const canonical = checkedLine(type, line);
  assertSelection(type, selection);
  const { home, away } = teams;
  if (type === 'ah' || type === 'eh') {
    const handicap = Number(canonical);
    const homeLine = formatHandicap(handicap);
    const awayLine = formatHandicap(-handicap);
    if (type === 'ah') {
      return same(selection === '1' ? `${home} ${homeLine}` : `${away} ${awayLine}`);
    }
    if (selection === 'X') return { en: `Draw (${homeLine})`, am: `አቻ (${homeLine})` };
    return same(selection === '1' ? `${home} (${homeLine})` : `${away} (${awayLine})`);
  }
  switch (selection) {
    case '1':
      return same(home);
    case '2':
      return same(away);
    case 'X':
      return { en: 'Draw', am: 'አቻ' };
    case '1X':
      return { en: `${home} or Draw`, am: `${home} ወይም አቻ` };
    case '12':
      return { en: `${home} or ${away}`, am: `${home} ወይም ${away}` };
    case 'X2':
      return { en: `Draw or ${away}`, am: `አቻ ወይም ${away}` };
    case 'over':
      return { en: `Over ${canonical}`, am: `ከ${canonical} በላይ` };
    case 'under':
      return { en: `Under ${canonical}`, am: `ከ${canonical} በታች` };
    case 'yes':
      return { en: 'Yes', am: 'አዎ' };
    case 'no':
      return { en: 'No', am: 'አይ' };
    case CORRECT_SCORE_OTHER:
      return { en: 'Any other score', am: 'ሌላ ውጤት' };
    default:
      // A correct-score selection: the score itself ("2-1").
      return same(selection);
  }
}

/**
 * Resolves one selection of a market against the event outcome.
 *
 * - A cancelled, abandoned or postponed event voids every selection.
 * - 'dnb' is void on a draw; 'ah' is void when the adjusted score is level
 *   (a whole line), so the stake comes back.
 * - 'ml' and 'winner' cannot end in a tie; a tied finished score throws.
 * - 'ht_1x2' needs the half-time score.
 *
 * The market, selection and (for a finished event) the score are validated
 * first: an unknown selection, a missing or malformed line, or a negative or
 * non-integer score throws a RangeError, as does a half-time score above the
 * full-time score.
 */
export function resolveSelection(
  market: { type: MarketTypeCode; line?: string | null },
  selection: string,
  input: ResolutionInput,
): SelectionResult {
  const { type } = market;
  const line = checkedLine(type, market.line);
  assertSelection(type, selection);

  const status: string = input.status;
  if (VOID_STATUSES.has(status)) return 'void';
  if (input.status !== 'finished') throw new RangeError(`unknown event status: "${status}"`);

  const score = checkedScore(input.score);
  const { home, away } = score;
  switch (type) {
    case '1x2':
      return wonIf(selection === outcomeOf(home, away));
    case 'ht_1x2': {
      const { htHome, htAway } = score;
      if (isAbsent(htHome) || isAbsent(htAway)) {
        throw new RangeError('the half-time score is required to settle ht_1x2');
      }
      return wonIf(selection === outcomeOf(htHome, htAway));
    }
    case 'dc':
      return wonIf(DOUBLE_CHANCE_COVERS[selection]?.includes(outcomeOf(home, away)) === true);
    case 'ou':
    case 'total': {
      const over = home + away > Number(line);
      return wonIf(selection === (over ? 'over' : 'under'));
    }
    case 'ah': {
      // Lines are whole or half numbers of goals, so the sum is exact.
      const margin = home - away + Number(line);
      if (margin === 0) return 'void';
      return wonIf(selection === (margin > 0 ? '1' : '2'));
    }
    case 'eh':
      return wonIf(selection === outcomeOf(home + Number(line), away));
    case 'btts':
      return wonIf((selection === 'yes') === (home > 0 && away > 0));
    case 'dnb': {
      const outcome = outcomeOf(home, away);
      return outcome === 'X' ? 'void' : wonIf(selection === outcome);
    }
    case 'cs': {
      const inGrid = home <= CORRECT_SCORE_MAX_GOALS && away <= CORRECT_SCORE_MAX_GOALS;
      return wonIf(selection === (inGrid ? `${home}-${away}` : CORRECT_SCORE_OTHER));
    }
    case 'ml':
    case 'winner': {
      if (home === away) {
        throw new RangeError(`a finished ${type} market cannot end in a tie (${home}-${away})`);
      }
      return wonIf(selection === (home > away ? '1' : '2'));
    }
    default: {
      const unreachable: never = type;
      throw new RangeError(`unknown market type: "${String(unreachable)}"`);
    }
  }
}

/**
 * The score of a match in play. The half-time score is set (both values)
 * once the first half is over, in football; until then both are null or
 * absent.
 */
export interface InPlayScore {
  home: number;
  away: number;
  htHome?: number | null;
  htAway?: number | null;
}

/** The result of every selection of a market, keyed by selection code. */
export type MarketResult = Readonly<Record<string, SelectionResult>>;

/**
 * The result of a market whose outcome is already CERTAIN in play, or null
 * while it can still change. Used to settle markets early (before full
 * time), so it never decides a market that a later goal or point could
 * still turn:
 *
 * - 'ou' / 'total': 'over' has won (and 'under' lost) once the score is
 *   above the line; 'under' can only win at full time.
 * - 'btts': 'yes' has won once both teams have scored; 'no' only at full time.
 * - 'cs': 'other' has won once either team has more than 4 goals (every
 *   score in the grid has lost).
 * - 'ht_1x2': decided by the half-time score once the first half is over.
 * - '1x2', 'dc', 'dnb', 'ah', 'eh', 'ml', 'winner': only at full time (always
 *   null): the goal difference can still move either way.
 *
 * When it returns a result, it is exactly what resolveSelection gives every
 * selection for ANY final score the match can still reach (each side's
 * score at least the current one, and the half-time score as given), so
 * full-time resulting agrees with it. That rests on the score being the
 * confirmed one: goals and points are never taken back. A feed whose scores
 * can be revised (a goal disallowed after review) must only pass scores it
 * has confirmed.
 *
 * Throws a RangeError (like resolveSelection) for an unknown market type, a
 * missing or malformed line, a negative or non-integer score, a half-time
 * score with only one side set, or a half-time score above the score.
 */
export function certainMarketResult(
  market: { type: MarketTypeCode; line?: string | null },
  score: InPlayScore,
): MarketResult | null {
  const { type } = market;
  const line = checkedLine(type, market.line);
  const current = checkedInPlayScore(score);
  const { home, away } = current;
  let decided: boolean;
  switch (type) {
    case 'ou':
    case 'total':
      decided = home + away > Number(line);
      break;
    case 'btts':
      decided = home > 0 && away > 0;
      break;
    case 'cs':
      decided = home > CORRECT_SCORE_MAX_GOALS || away > CORRECT_SCORE_MAX_GOALS;
      break;
    case 'ht_1x2':
      decided = current.htHome !== null && current.htAway !== null;
      break;
    case '1x2':
    case 'dc':
    case 'dnb':
    case 'ah':
    case 'eh':
    case 'ml':
    case 'winner':
      decided = false;
      break;
    default: {
      const unreachable: never = type;
      throw new RangeError(`unknown market type: "${String(unreachable)}"`);
    }
  }
  if (!decided) return null;
  // The outcome no longer depends on what is still to come, so resolving
  // against the current score as if it were final gives the certain result.
  const asFinal: ResolutionInput = { status: 'finished', score: current };
  const result: Record<string, SelectionResult> = {};
  for (const selection of selectionsFor(type)) {
    result[selection] = resolveSelection(market, selection, asFinal);
  }
  return Object.freeze(result);
}

function checkedInPlayScore(score: InPlayScore): {
  home: number;
  away: number;
  htHome: number | null;
  htAway: number | null;
} {
  if (typeof score !== 'object' || score === null) {
    throw new RangeError('an in-play score is required');
  }
  const checked = checkedScore(score);
  const htHome = checked.htHome ?? null;
  const htAway = checked.htAway ?? null;
  if ((htHome === null) !== (htAway === null)) {
    throw new RangeError('half-time scores must both be set or both be absent');
  }
  return { home: checked.home, away: checked.away, htHome, htAway };
}

function definitionOf(type: MarketTypeCode): MarketTypeDefinition {
  const definition = Object.hasOwn(MARKET_TYPES, type) ? MARKET_TYPES[type] : undefined;
  if (definition === undefined) throw new RangeError(`unknown market type: "${String(type)}"`);
  return definition;
}

/** Validates the line against the market type; returns its canonical text, or null. */
function checkedLine(type: MarketTypeCode, line: string | null | undefined): string | null {
  const definition = definitionOf(type);
  if (definition.hasLine) {
    if (isAbsent(line)) throw new RangeError(`market "${type}" requires a line`);
    if (type === 'ah') return String(parseHandicap(line));
    if (type === 'eh') return String(parseHandicap(line, { wholeOnly: true }));
    return String(parseLine(line));
  }
  if (!isAbsent(line)) {
    throw new RangeError(`market "${type}" does not take a line (got "${String(line)}")`);
  }
  return null;
}

function assertSelection(type: MarketTypeCode, selection: string): void {
  if (!selectionsFor(type).includes(selection)) {
    throw new RangeError(`invalid selection "${String(selection)}" for market "${type}"`);
  }
}

function checkedScore(score: FinalScore): FinalScore {
  if (typeof score !== 'object' || score === null) {
    throw new RangeError('a finished event needs a score');
  }
  const home = checkedPoints(score.home, 'home score');
  const away = checkedPoints(score.away, 'away score');
  const htHome = isAbsent(score.htHome)
    ? null
    : checkedPoints(score.htHome, 'half-time home score');
  const htAway = isAbsent(score.htAway)
    ? null
    : checkedPoints(score.htAway, 'half-time away score');
  if ((htHome !== null && htHome > home) || (htAway !== null && htAway > away)) {
    throw new RangeError(
      `half-time score ${htHome}-${htAway} exceeds the full-time score ${home}-${away}`,
    );
  }
  return { home, away, htHome, htAway };
}

function checkedPoints(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`invalid ${what}: ${String(value)}`);
  }
  return value;
}

function outcomeOf(home: number, away: number): Outcome {
  if (home > away) return '1';
  return home === away ? 'X' : '2';
}

function wonIf(won: boolean): SelectionResult {
  return won ? 'won' : 'lost';
}

function same(text: string): Label {
  return { en: text, am: text };
}

function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

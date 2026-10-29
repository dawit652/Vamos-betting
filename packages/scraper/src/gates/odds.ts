import {
  isValidOddsMilli,
  MARKET_TYPES,
  type MarketTypeCode,
  marketKey,
  selectionsFor,
} from '@vamos/core';
import {
  MAX_PRICE_MOVE_RATIO,
  MIN_RATING_MATCHES,
  OVERROUND_MAX,
  OVERROUND_MIN,
} from '../constants';
import { listOf } from './internal';
import { buildReviews, type GateJson, type GateReview } from './review';

/**
 * Odds rules O1–O3 (docs/scraper.md 6.5): whether in-house prices may be
 * offered. Fail closed: anything malformed (unknown market, bad line, missing
 * or extra selection, invalid price, an empty book) fails the check.
 *
 * Overround and price-move bounds are compared EXACTLY, in rational
 * arithmetic on bigint (odds are integer milli; the float constants are read
 * as the decimals they are written as, 1.01 = 101/100). There is therefore no
 * float tolerance: a book exactly on a bound passes, one a hair outside fails.
 */

/** A priced market, structurally the same as FeedMarket of @vamos/feed. */
export interface GateMarket {
  readonly type: MarketTypeCode;
  readonly line: string | null;
  readonly selections: readonly { readonly code: string; readonly oddsMilli: number }[];
}

/**
 * How many selections win for every possible outcome of each market type: the
 * overround (Σ implied probability) is divided by it before the
 * [OVERROUND_MIN, OVERROUND_MAX] check. 1 = the selections partition the
 * outcomes: '1x2', 'ht_1x2', 'btts', 'ou'/'total' (half-point lines), 'dnb'
 * (void on a draw, a partition of the other outcomes), 'ml'/'winner' (no ties)
 * and 'cs' (the 4×4 grid plus 'other' covers every score). 'dc' covers every
 * outcome exactly twice. A book under the bound is a guaranteed win for a
 * bettor backing every selection, so every market is checked.
 */
export const MARKET_OUTCOME_COVER: Readonly<Record<MarketTypeCode, number>> = Object.freeze({
  '1x2': 1,
  dc: 2,
  ou: 1,
  btts: 1,
  dnb: 1,
  ht_1x2: 1,
  cs: 1,
  ml: 1,
  total: 1,
  winner: 1,
});

/**
 * O1: a team's ratings may price real bets. True when `manual` is exactly 1 (a
 * trader verified the team) or `matches` is an integer of at least
 * `minMatches`, which is never taken below MIN_RATING_MATCHES. Missing or
 * malformed ratings are uncalibrated. A negative or non-integer `minMatches`
 * is a programmer error.
 */
export function isCalibrated(
  ratings: Readonly<Record<string, unknown>> | null | undefined,
  minMatches: number = MIN_RATING_MATCHES,
): boolean {
  if (!Number.isSafeInteger(minMatches) || minMatches < 0) {
    throw new RangeError(`minMatches must be an integer >= 0, got ${minMatches}`);
  }
  if (typeof ratings !== 'object' || ratings === null) return false;
  if (Object.hasOwn(ratings, 'manual') && ratings.manual === 1) return true;
  const matches = Object.hasOwn(ratings, 'matches') ? ratings.matches : undefined;
  return (
    typeof matches === 'number' &&
    Number.isSafeInteger(matches) &&
    matches >= Math.max(minMatches, MIN_RATING_MATCHES)
  );
}

export type OddsIssueCode =
  | 'no_markets'
  | 'unknown_market'
  | 'bad_line'
  | 'duplicate_market'
  | 'bad_selections'
  | 'invalid_price'
  | 'overround_low'
  | 'overround_high'
  | 'market_set_changed'
  | 'selection_set_changed'
  | 'price_move_too_large'
  /** O3 + S4: the competition's policy is switched off, so nothing is re-priced by itself. */
  | 'policy_disabled';

export interface OddsIssue {
  readonly code: OddsIssueCode;
  /** marketKey ('1x2', 'ou:2.5'), or null for the whole book. */
  readonly market: string | null;
  readonly selection: string | null;
  readonly detail: string;
}

export type OddsCheck =
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly OddsIssue[] };

interface Ratio {
  num: bigint;
  den: bigint;
}

/** A positive constant as the exact decimal it is written as (Number#toString round-trips). */
function decimalRatio(value: number): Ratio {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(value));
  if (match === null || !(value > 0)) throw new RangeError(`not a positive decimal: ${value}`);
  const [, whole = '0', fraction = '', exponent = '0'] = match;
  let num = BigInt(whole + fraction);
  let den = 10n ** BigInt(fraction.length);
  const exp = Number(exponent);
  if (exp > 0) num *= 10n ** BigInt(exp);
  if (exp < 0) den *= 10n ** BigInt(-exp);
  return { num, den };
}

const OVERROUND_LOW = decimalRatio(OVERROUND_MIN);
const OVERROUND_HIGH = decimalRatio(OVERROUND_MAX);
const MOVE = decimalRatio(MAX_PRICE_MOVE_RATIO);

function issue(
  code: OddsIssueCode,
  market: string | null,
  selection: string | null,
  detail: string,
): OddsIssue {
  return { code, market, selection, detail };
}

function result(issues: OddsIssue[]): OddsCheck {
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** A market's key, or null (with an issue) when its type or line is invalid. */
function keyOf(market: GateMarket, issues: OddsIssue[]): string | null {
  const type = market?.type;
  if (typeof type !== 'string' || !Object.hasOwn(MARKET_TYPES, type)) {
    issues.push(issue('unknown_market', null, null, `unknown market type ${String(type)}`));
    return null;
  }
  try {
    return marketKey(type, market.line);
  } catch (error) {
    issues.push(issue('bad_line', type, null, error instanceof Error ? error.message : 'bad line'));
    return null;
  }
}

/** Exactly the selections of selectionsFor(type), each once, each with a valid price. */
function selectionsProblems(market: GateMarket, key: string, issues: OddsIssue[]): boolean {
  const expected = selectionsFor(market.type);
  const selections = listOf(market.selections);
  const codes = selections.map((s) => s?.code);
  const unique = new Set(codes);
  const exact =
    codes.length === expected.length &&
    unique.size === codes.length &&
    expected.every((code) => unique.has(code));
  if (!exact) {
    issues.push(
      issue('bad_selections', key, null, `expected ${expected.join(',')}, got ${codes.join(',')}`),
    );
  }
  let pricesValid = true;
  for (const selection of selections) {
    if (!isValidOddsMilli(selection?.oddsMilli)) {
      pricesValid = false;
      issues.push(
        issue(
          'invalid_price',
          key,
          String(selection?.code),
          `invalid odds ${String(selection?.oddsMilli)}`,
        ),
      );
    }
  }
  return exact && pricesValid;
}

/**
 * O2: every price is valid odds and every book's overround (Σ 1000/odds,
 * divided by MARKET_OUTCOME_COVER) lies in [OVERROUND_MIN, OVERROUND_MAX].
 * An empty list of markets fails (nothing sane to open).
 */
export function checkMarkets(markets: readonly GateMarket[]): OddsCheck {
  const list = listOf(markets);
  const issues: OddsIssue[] = [];
  if (list.length === 0) issues.push(issue('no_markets', null, null, 'no market priced'));
  const seen = new Set<string>();
  for (const market of list) {
    const key = keyOf(market, issues);
    if (key === null) continue;
    if (seen.has(key)) issues.push(issue('duplicate_market', key, null, 'market given twice'));
    seen.add(key);
    if (!selectionsProblems(market, key, issues)) continue;
    // Σ 1000/o_i = S / P with P = Π o_i, compared exactly.
    const odds = market.selections.map((s) => BigInt(s.oddsMilli));
    const product = odds.reduce((p, o) => p * o, 1n);
    const sum = odds.reduce((s, o) => s + (1000n * product) / o, 0n);
    const cover = BigInt(MARKET_OUTCOME_COVER[market.type]);
    const shown = (
      market.selections.reduce((s, x) => s + 1000 / x.oddsMilli, 0) / Number(cover)
    ).toFixed(4);
    if (sum * OVERROUND_LOW.den < OVERROUND_LOW.num * cover * product) {
      issues.push(issue('overround_low', key, null, `overround ${shown} < ${OVERROUND_MIN}`));
    } else if (sum * OVERROUND_HIGH.den > OVERROUND_HIGH.num * cover * product) {
      issues.push(issue('overround_high', key, null, `overround ${shown} > ${OVERROUND_MAX}`));
    }
  }
  return result(issues);
}

/**
 * O3: a re-price may replace `previous` by `next` without a person only if
 * both books have the same markets and selections, `next` passes O2, and every
 * selection stays within [previous / MAX_PRICE_MOVE_RATIO, previous ×
 * MAX_PRICE_MOVE_RATIO] (exactly on a bound passes).
 */
export function checkReprice(
  previous: readonly GateMarket[],
  next: readonly GateMarket[],
): OddsCheck {
  const issues: OddsIssue[] = [];
  const index = (markets: readonly GateMarket[]): Map<string, Map<string, number>> => {
    const scratch: OddsIssue[] = [];
    const out = new Map<string, Map<string, number>>();
    for (const market of listOf(markets)) {
      const key = keyOf(market, scratch);
      if (key === null) continue;
      const prices = new Map<string, number>();
      for (const s of listOf(market.selections)) prices.set(String(s?.code), s?.oddsMilli);
      out.set(key, prices);
    }
    return out;
  };
  const before = index(previous);
  const after = index(next);
  const nextCheck = checkMarkets(next);
  if (!nextCheck.ok) issues.push(...nextCheck.issues);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key);
    const now = after.get(key);
    if (old === undefined || now === undefined) {
      issues.push(
        issue(
          'market_set_changed',
          key,
          null,
          old === undefined ? 'market added' : 'market removed',
        ),
      );
      continue;
    }
    for (const code of new Set([...old.keys(), ...now.keys()])) {
      const from = old.get(code);
      const to = now.get(code);
      if (from === undefined || to === undefined) {
        issues.push(
          issue(
            'selection_set_changed',
            key,
            code,
            from === undefined ? 'selection added' : 'selection removed',
          ),
        );
        continue;
      }
      if (!isValidOddsMilli(from) || !isValidOddsMilli(to)) {
        issues.push(
          issue('invalid_price', key, code, `cannot compare ${String(from)} → ${String(to)}`),
        );
        continue;
      }
      // to ≤ from × R  and  to ≥ from / R, with R = num/den.
      const a = BigInt(from);
      const b = BigInt(to);
      if (b * MOVE.den > a * MOVE.num || b * MOVE.num < a * MOVE.den) {
        issues.push(issue('price_move_too_large', key, code, `${String(from)} → ${String(to)}`));
      }
    }
  }
  return result(issues);
}

/** Suffix of the subject key of a re-price item (`<feedRef>|reprice`). */
export const REPRICE_SUBJECT_SUFFIX = '|reprice';

/**
 * A fingerprint of the ratings a book is priced from (rule O3): the numeric
 * entries of both teams' ratings, keys sorted, as text. Two equal fingerprints
 * price the same book, so a stamp of it says whether the stored prices are
 * current. `null` ratings and `{}` are the same (both price from neutral).
 */
export function ratingsKey(
  home: Readonly<Record<string, unknown>> | null | undefined,
  away: Readonly<Record<string, unknown>> | null | undefined,
): string {
  const side = (ratings: Readonly<Record<string, unknown>> | null | undefined): string => {
    if (typeof ratings !== 'object' || ratings === null) return '[]';
    const entries = Object.entries(ratings)
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(entries);
  };
  return `${side(home)}|${side(away)}`;
}

/**
 * The `odds_approval` item for a refused re-price (O3: the old prices stay).
 * Its subject is the event's feedRef suffixed with '|reprice', so it never
 * merges with the F7 item that asks a trader to open betting. `extra` is
 * merged into the payload first (the runner adds what a person needs to read
 * the item: names, kickoff, the ratings fingerprint the proposal belongs to);
 * the gate's own fields win.
 */
export function repriceReview(
  event: { readonly eventId: string; readonly feedRef: string },
  next: readonly GateMarket[],
  check: Extract<OddsCheck, { ok: false }>,
  extra: { readonly [key: string]: GateJson } = {},
): GateReview<'odds_approval'> {
  const proposal: GateJson = next.map((m) => ({
    type: m.type,
    line: m.line,
    selections: m.selections.map((s) => ({ code: s.code, oddsMilli: s.oddsMilli })),
  }));
  const [review] = buildReviews(
    `${event.feedRef}${REPRICE_SUBJECT_SUFFIX}`,
    check.issues.map((i) => ({ kind: 'odds_approval' as const, rule: 'O3', reason: i.code })),
    () => ({
      ...extra,
      eventId: event.eventId,
      feedRef: event.feedRef,
      proposal,
      issues: check.issues.map((i) => ({ ...i })),
    }),
  );
  if (review === undefined) throw new Error('internal: odds_approval review missing');
  return { ...review, kind: 'odds_approval' };
}

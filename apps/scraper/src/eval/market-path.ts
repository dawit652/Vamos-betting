import { marketConsensus, type MarketPriceRow } from '@vamos/core';
import {
  DEFAULT_ASIAN_HANDICAP_LINES,
  MAX_MARKET_FIT_RESIDUAL,
  priceFootballFromMarket,
  type FeedMarket,
} from '@vamos/feed';
import {
  bootstrap,
  brier2,
  brier3,
  logLoss2,
  logLoss3,
  mean,
  num,
  outcomeOf,
  parseCsv,
  proportional,
  reliability,
  round,
  rps3,
  type Outcome,
  type Probs3,
} from './odds-lib';

/**
 * Offline evaluation of the market pricing path (M-4 of docs/feed-quality-plan.md): what
 * `priceFootballFromMarket` prices from the closing odds of several books in a football-data.co.uk
 * file, scored against the results. Measurement only: nothing here is used by production code.
 *
 * Per match the consensus is built the way production builds it (marketConsensus over the books'
 * rows: proportional de-vig per book, median, at least two books), priced with the default
 * margins, and our own margin is removed again (proportional) before scoring, so the numbers are
 * forecasts, not odds. Markets with no bookmaker odds in the file (BTTS, half-time 1X2, correct
 * score) are scored against the results and the sample's base rate only.
 */

export type Basis = 'close' | 'open';

/** football-data.co.uk book prefixes: 1X2 columns `<p>CH/CD/CA`; the over/under prefix differs (Pinnacle is `P`). */
const BOOKS_1X2 = ['B365', 'BW', 'IW', 'PS', 'WH', 'VC', '1XB'] as const;
const BOOKS_OU: ReadonlyArray<{ book: string; prefix: string }> = [
  { book: 'B365', prefix: 'B365' },
  { book: 'PS', prefix: 'P' },
];
const OU_LINE = '2.5';
const AH_LINES: ReadonlySet<string> = new Set(DEFAULT_ASIAN_HANDICAP_LINES);

export interface MatchInput {
  div: string;
  date: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  hthg: number | null;
  htag: number | null;
  rows: MarketPriceRow[];
  /** No-vig (proportional) Pinnacle closing prices, when the file has them. */
  pinnacle1x2: Probs3 | null;
  pinnacleOver: number | null;
  /** Market average (`Avg*`) no-vig 1X2. */
  average1x2: Probs3 | null;
  /** The Asian handicap line of the home side as written in the file, and Pinnacle's no-vig home probability. */
  ah: { line: number; pinnacleHome: number | null } | null;
}

const milli = (odds: number): number => Math.round(odds * 1000);

function pick(row: Record<string, string>, names: readonly string[]): number[] | null {
  const values = names.map((n) => num(row[n]));
  return values.every((v): v is number => v !== null && v > 1) ? values : null;
}

/** Reads one CSV row; null without a final score (a match not played). */
export function readMatch(row: Record<string, string>, basis: Basis = 'close'): MatchInput | null {
  const hg = num(row.FTHG);
  const ag = num(row.FTAG);
  if (hg === null || ag === null) return null;
  const c = basis === 'close' ? 'C' : '';
  const rows: MarketPriceRow[] = [];
  for (const b of BOOKS_1X2) {
    const odds = pick(row, [`${b}${c}H`, `${b}${c}D`, `${b}${c}A`]);
    if (odds === null) continue;
    (['1', 'X', '2'] as const).forEach((selection, i) =>
      rows.push({
        bookmaker: b,
        market: '1x2',
        line: null,
        selection,
        priceMilli: milli(odds[i]!),
      }),
    );
  }
  for (const { book, prefix } of BOOKS_OU) {
    const odds = pick(row, [`${prefix}${c}>${OU_LINE}`, `${prefix}${c}<${OU_LINE}`]);
    if (odds === null) continue;
    (['over', 'under'] as const).forEach((selection, i) =>
      rows.push({
        bookmaker: book,
        market: 'ou',
        line: OU_LINE,
        selection,
        priceMilli: milli(odds[i]!),
      }),
    );
  }
  const pin = pick(row, [`PS${c}H`, `PS${c}D`, `PS${c}A`]);
  const pinOu = pick(row, [`P${c}>${OU_LINE}`, `P${c}<${OU_LINE}`]);
  const avg = pick(row, [`Avg${c}H`, `Avg${c}D`, `Avg${c}A`]);
  const ahLine = num(row[basis === 'close' ? 'AHCh' : 'AHh']);
  const pinAh = pick(row, [`P${c}AHH`, `P${c}AHA`]);
  const prob3 = (o: number[] | null): Probs3 | null => {
    if (o === null) return null;
    const p = proportional(o);
    return [p[0]!, p[1]!, p[2]!];
  };
  const htg = (v: string | undefined): number | null => num(v);
  return {
    div: row.Div === undefined || row.Div === '' ? 'all' : row.Div,
    date: row.Date ?? '',
    home: row.HomeTeam ?? '',
    away: row.AwayTeam ?? '',
    hg,
    ag,
    hthg: htg(row.HTHG),
    htag: htg(row.HTAG),
    rows,
    pinnacle1x2: prob3(pin),
    pinnacleOver: pinOu === null ? null : proportional(pinOu)[0]!,
    average1x2: prob3(avg),
    ah:
      ahLine === null
        ? null
        : { line: ahLine, pinnacleHome: pinAh === null ? null : proportional(pinAh)[0]! },
  };
}

export function readMatches(csv: string, basis: Basis = 'close'): MatchInput[] {
  return parseCsv(csv).flatMap((r) => {
    const m = readMatch(r, basis);
    return m === null ? [] : [m];
  });
}

/** One forecast per market for one match, with what happened. */
export interface MatchScores {
  div: string;
  outcome: Outcome;
  oneXTwo: { ours: Probs3; consensus: Probs3; pinnacle: Probs3 | null; average: Probs3 | null };
  over25: { ours: number; consensus: number; pinnacle: number | null; hit: boolean };
  btts: { ours: number; hit: boolean };
  /** Only for lines we price (half and whole lines, 0 as draw no bet) and not a push. */
  ah: { line: string; ours: number; pinnacle: number | null; home: boolean } | null;
  ahStatus: 'scored' | 'push' | 'unpriced_line' | 'none';
  halfTime: { ours: Probs3; outcome: Outcome } | null;
  correctScore: { ours: Readonly<Record<string, number>>; key: string };
  residual: number;
}

export type SkipReason = 'no_consensus' | 'no_totals';

/** Proportional de-vig of a market's prices: our own margin removed. */
function fair(markets: readonly FeedMarket[], type: string, line: string | null) {
  const m = markets.find((x) => x.type === type && x.line === line);
  if (m === undefined) return null;
  const p = proportional(m.selections.map((s) => s.oddsMilli / 1000));
  return Object.fromEntries(m.selections.map((s, i) => [s.code, p[i]!])) as Record<string, number>;
}

const triple = (p: Record<string, number>): Probs3 => [p['1']!, p.X!, p['2']!];

export function scoreMatch(m: MatchInput): { scores: MatchScores } | { skipped: SkipReason } {
  const consensus = marketConsensus(m.rows);
  const x12 = consensus.find((c) => c.market === '1x2');
  const ou = consensus.find((c) => c.market === 'ou' && c.line === OU_LINE);
  if (x12 === undefined) return { skipped: 'no_consensus' };
  const priced = priceFootballFromMarket(consensus);
  if (priced === null || ou === undefined) return { skipped: 'no_totals' };

  const ours1x2 = fair(priced.markets, '1x2', null);
  const oursOu = fair(priced.markets, 'ou', OU_LINE);
  const oursBtts = fair(priced.markets, 'btts', null);
  const oursCs = fair(priced.markets, 'cs', null);
  if (ours1x2 === null || oursOu === null || oursBtts === null || oursCs === null) {
    return { skipped: 'no_totals' };
  }
  const oursHt = fair(priced.markets, 'ht_1x2', null);

  let ah: MatchScores['ah'] = null;
  let ahStatus: MatchScores['ahStatus'] = 'none';
  if (m.ah !== null) {
    const key = String(m.ah.line);
    const probs =
      m.ah.line === 0
        ? fair(priced.markets, 'dnb', null)
        : AH_LINES.has(key)
          ? fair(priced.markets, 'ah', key)
          : null;
    const margin = m.hg - m.ag + m.ah.line;
    if (probs === null) ahStatus = 'unpriced_line';
    else if (margin === 0) ahStatus = 'push';
    else {
      ahStatus = 'scored';
      ah = { line: key, ours: probs['1']!, pinnacle: m.ah.pinnacleHome, home: margin > 0 };
    }
  }

  const csKey = `${m.hg}-${m.ag}` in oursCs ? `${m.hg}-${m.ag}` : 'other';
  return {
    scores: {
      div: m.div,
      outcome: outcomeOf(m.hg, m.ag),
      oneXTwo: {
        ours: triple(ours1x2),
        consensus: triple(x12.probabilities),
        pinnacle: m.pinnacle1x2,
        average: m.average1x2,
      },
      over25: {
        ours: oursOu.over!,
        consensus: ou.probabilities.over!,
        pinnacle: m.pinnacleOver,
        hit: m.hg + m.ag > 2.5,
      },
      btts: { ours: oursBtts.yes!, hit: m.hg > 0 && m.ag > 0 },
      ah,
      ahStatus,
      halfTime:
        oursHt === null || m.hthg === null || m.htag === null
          ? null
          : { ours: triple(oursHt), outcome: outcomeOf(m.hthg, m.htag) },
      correctScore: { ours: oursCs, key: csKey },
      residual: priced.residual,
    },
  };
}

// ------------------------------------------------------------------ metrics

export interface Score3 {
  n: number;
  logLoss: number;
  brier: number;
  rps: number;
}
export interface Score2 {
  n: number;
  logLoss: number;
  brier: number;
}
export interface Rel {
  value: number;
  lo: number;
  hi: number;
}

const BOOT_REPS = 1000;

/** Mean multi-class scores of forecasts and outcomes. */
export function score3(forecasts: readonly Probs3[], outcomes: readonly Outcome[]): Score3 | null {
  if (forecasts.length === 0) return null;
  const at = <T>(f: (p: Probs3, o: Outcome) => T): T[] =>
    forecasts.map((p, i) => f(p, outcomes[i]!));
  return {
    n: forecasts.length,
    logLoss: mean(at(logLoss3)),
    brier: mean(at(brier3)),
    rps: mean(at(rps3)),
  };
}

export function score2(forecasts: readonly number[], hits: readonly boolean[]): Score2 | null {
  if (forecasts.length === 0) return null;
  return {
    n: forecasts.length,
    logLoss: mean(forecasts.map((p, i) => logLoss2(p, hits[i]!))),
    brier: mean(forecasts.map((p, i) => brier2(p, hits[i]!))),
  };
}

/** Log-loss of a forecast over categories: the probability given to what happened. */
export function logLossCategorical(p: Readonly<Record<string, number>>, key: string): number {
  return -Math.log(Math.max(1e-12, p[key] ?? 0));
}

/** mean(a) / mean(b) - 1 with a percentile bootstrap over the rows (null when empty). */
export function relativeDifference(a: readonly number[], b: readonly number[]): Rel | null {
  if (a.length === 0 || a.length !== b.length) return null;
  const i = bootstrap(
    a.length,
    (idx) => mean(idx.map((k) => a[k]!)) / mean(idx.map((k) => b[k]!)) - 1,
    41,
    BOOT_REPS,
  );
  return { value: i.value, lo: i.lo, hi: i.hi };
}

/** Frequency of each outcome in the sample, as a constant forecast. */
export function baseRate3(outcomes: readonly Outcome[]): Probs3 | null {
  if (outcomes.length === 0) return null;
  const c = [0, 0, 0];
  for (const o of outcomes) c[o] = (c[o] ?? 0) + 1;
  return [c[0]! / outcomes.length, c[1]! / outcomes.length, c[2]! / outcomes.length];
}

export interface Calibration {
  n: number;
  eceVsObservedPp: number;
  biasPp: number;
}

function calibrationOf(pred: readonly number[], hit: readonly boolean[]): Calibration | null {
  if (pred.length === 0) return null;
  const r = reliability(pred, hit);
  return { n: r.n, eceVsObservedPp: r.eceInterval.value, biasPp: r.biasPp.value };
}

export interface BinarySection {
  ours: Score2 | null;
  consensus?: Score2 | null;
  baseRate: Score2 | null;
  vsPinnacle: {
    n: number;
    ours: Score2 | null;
    pinnacle: Score2 | null;
    relLogLoss: Rel | null;
  };
  calibration: Calibration | null;
}

function binarySection(
  rows: ReadonlyArray<{ ours: number; hit: boolean; consensus?: number; pinnacle?: number | null }>,
): BinarySection {
  const hits = rows.map((r) => r.hit);
  const rate = rows.length === 0 ? 0 : mean(hits.map((h) => (h ? 1 : 0)));
  const paired = rows.filter((r) => r.pinnacle !== undefined && r.pinnacle !== null);
  const oursP = paired.map((r) => logLoss2(r.ours, r.hit));
  const pinP = paired.map((r) => logLoss2(r.pinnacle!, r.hit));
  const withConsensus = rows.every((r) => r.consensus !== undefined);
  return {
    ours: score2(
      rows.map((r) => r.ours),
      hits,
    ),
    ...(withConsensus && rows.length > 0
      ? {
          consensus: score2(
            rows.map((r) => r.consensus!),
            hits,
          ),
        }
      : {}),
    baseRate: score2(
      rows.map(() => rate),
      hits,
    ),
    vsPinnacle: {
      n: paired.length,
      ours: score2(
        paired.map((r) => r.ours),
        paired.map((r) => r.hit),
      ),
      pinnacle: score2(
        paired.map((r) => r.pinnacle!),
        paired.map((r) => r.hit),
      ),
      relLogLoss: relativeDifference(oursP, pinP),
    },
    calibration: calibrationOf(
      rows.map((r) => r.ours),
      hits,
    ),
  };
}

export interface TernarySection {
  ours: Score3 | null;
  baseRate: Score3 | null;
  consensus?: Score3 | null;
  vsPinnacle?: { n: number; ours: Score3 | null; pinnacle: Score3 | null; relLogLoss: Rel | null };
  calibration: Calibration | null;
}

export interface Section {
  matches: number;
  fit: { meanResidual: number | null; shareAboveMax: number | null };
  oneXTwo: TernarySection;
  overUnder25: BinarySection;
  btts: BinarySection;
  asianHandicap: {
    /** Matches with a closing line, by what became of them. */
    scored: number;
    push: number;
    unpricedLine: number;
    none: number;
    result: BinarySection;
  };
  halfTime1x2: TernarySection;
  correctScore: {
    n: number;
    logLoss: number | null;
    baseRateLogLoss: number | null;
  };
}

function ternarySection(
  rows: ReadonlyArray<{
    ours: Probs3;
    outcome: Outcome;
    consensus?: Probs3;
    pinnacle?: Probs3 | null;
  }>,
  withPinnacle: boolean,
): TernarySection {
  const outcomes = rows.map((r) => r.outcome);
  const base = baseRate3(outcomes);
  const section: TernarySection = {
    ours: score3(
      rows.map((r) => r.ours),
      outcomes,
    ),
    baseRate:
      base === null
        ? null
        : score3(
            rows.map(() => base),
            outcomes,
          ),
    calibration: calibrationOf(
      rows.flatMap((r) => [r.ours[0], r.ours[1], r.ours[2]]),
      rows.flatMap((r) => [r.outcome === 0, r.outcome === 1, r.outcome === 2]),
    ),
  };
  if (rows.length > 0 && rows.every((r) => r.consensus !== undefined)) {
    section.consensus = score3(
      rows.map((r) => r.consensus!),
      outcomes,
    );
  }
  if (withPinnacle) {
    const paired = rows.filter((r) => r.pinnacle !== undefined && r.pinnacle !== null);
    const o = paired.map((r) => r.outcome);
    section.vsPinnacle = {
      n: paired.length,
      ours: score3(
        paired.map((r) => r.ours),
        o,
      ),
      pinnacle: score3(
        paired.map((r) => r.pinnacle!),
        o,
      ),
      relLogLoss: relativeDifference(
        paired.map((r) => logLoss3(r.ours, r.outcome)),
        paired.map((r) => logLoss3(r.pinnacle!, r.outcome)),
      ),
    };
  }
  return section;
}

/** Aggregates the scored matches of one group. */
export function summarise(all: readonly MatchScores[]): Section {
  const ah = all.flatMap((s) => (s.ah === null ? [] : [s.ah]));
  const ht = all.flatMap((s) => (s.halfTime === null ? [] : [s.halfTime]));
  const keys = all.map((s) => s.correctScore.key);
  const freq = new Map<string, number>();
  for (const k of keys) freq.set(k, (freq.get(k) ?? 0) + 1);
  const csBase = (k: string): Record<string, number> => ({ [k]: (freq.get(k) ?? 0) / keys.length });
  const count = (status: MatchScores['ahStatus']): number =>
    all.filter((s) => s.ahStatus === status).length;
  const csLoss = all.map((s) => logLossCategorical(s.correctScore.ours, s.correctScore.key));
  return {
    matches: all.length,
    fit: {
      meanResidual: all.length === 0 ? null : mean(all.map((s) => s.residual)),
      shareAboveMax:
        all.length === 0
          ? null
          : all.filter((s) => s.residual > MAX_MARKET_FIT_RESIDUAL).length / all.length,
    },
    oneXTwo: ternarySection(
      all.map((s) => ({
        ours: s.oneXTwo.ours,
        outcome: s.outcome,
        consensus: s.oneXTwo.consensus,
        pinnacle: s.oneXTwo.pinnacle,
      })),
      true,
    ),
    overUnder25: binarySection(all.map((s) => s.over25)),
    btts: binarySection(all.map((s) => s.btts)),
    asianHandicap: {
      scored: count('scored'),
      push: count('push'),
      unpricedLine: count('unpriced_line'),
      none: count('none'),
      result: binarySection(ah.map((a) => ({ ours: a.ours, hit: a.home, pinnacle: a.pinnacle }))),
    },
    halfTime1x2: ternarySection(
      ht.map((h) => ({ ours: h.ours, outcome: h.outcome })),
      false,
    ),
    correctScore: {
      n: all.length,
      logLoss: all.length === 0 ? null : mean(csLoss),
      baseRateLogLoss:
        all.length === 0 ? null : mean(keys.map((k) => logLossCategorical(csBase(k), k))),
    },
  };
}

export interface MarketPathReport {
  basis: Basis;
  rows: number;
  skipped: Record<SkipReason, number>;
  overall: Section;
  byDivision: Array<{ division: string; section: Section }>;
}

export function evaluateMarketPath(matches: readonly MatchInput[], basis: Basis): MarketPathReport {
  const scores: MatchScores[] = [];
  const skipped: Record<SkipReason, number> = { no_consensus: 0, no_totals: 0 };
  for (const m of matches) {
    const r = scoreMatch(m);
    if ('skipped' in r) skipped[r.skipped]++;
    else scores.push(r.scores);
  }
  const divisions = [...new Set(scores.map((s) => s.div))].sort();
  return {
    basis,
    rows: matches.length,
    skipped,
    overall: summarise(scores),
    byDivision: divisions.map((division) => ({
      division,
      section: summarise(scores.filter((s) => s.div === division)),
    })),
  };
}

/** Rounds every number of a report for printing and JSON. */
export function roundReport<T>(value: T, digits = 4): T {
  if (typeof value === 'number') return round(value, digits) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => roundReport(v, digits)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, roundReport(v, digits)]),
    ) as T;
  }
  return value;
}

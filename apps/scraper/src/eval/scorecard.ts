import type { ClosePriceEvent, StoredClosePrice } from '@vamos/db';
import {
  brier2,
  brier3,
  logLoss2,
  logLoss3,
  outcomeOf,
  rps3,
  type Outcome,
  type Probs3,
} from './odds-lib';

/**
 * The scorecard of the prices at betting close (rule M1, M-2 of docs/feed-quality-plan.md).
 * Measurement only: pure functions, rows in and numbers out; rounding is the printer's job and
 * an empty sample is `null`, never NaN.
 */

const PPM = 1_000_000;
const VOID_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'abandoned', 'postponed']);
const OU_LINE = '2.5';
export const CALIBRATION_BINS = 10;

/** Mean scores of a 1X2 forecaster over a sample. */
export interface Score3 {
  brier: number;
  logLoss: number;
  rps: number;
}

/** Mean scores of an over/under forecaster over a sample. */
export interface Score2 {
  brier: number;
  logLoss: number;
}

export interface Sample {
  /** Events with captured prices in this group. */
  events: number;
  /** Finished with both scores: the only ones that are scored. */
  settled: number;
  /** Cancelled, abandoned or postponed. */
  void: number;
  /** Not resulted yet (or no result row to read). */
  pending: number;
}

export interface Matched3 {
  n: number;
  ours: Score3 | null;
  consensus: Score3 | null;
}

export interface MatchedWithPinnacle extends Matched3 {
  pinnacle: Score3 | null;
  /** mean(our log-loss) / mean(Pinnacle's) - 1; the plan's target is within 1%. */
  relLogLossVsPinnacle: number | null;
}

export interface Matched2 {
  n: number;
  ours: Score2 | null;
  consensus: Score2 | null;
}

export interface MatchedWithPinnacle2 extends Matched2 {
  pinnacle: Score2 | null;
  relLogLossVsPinnacle: number | null;
}

export interface CalibrationBin {
  bin: string;
  n: number;
  meanPredicted: number | null;
  observed: number | null;
}

export interface OverroundMeans {
  /** Event-markets with all our selections priced. */
  oursN: number;
  oursMean: number | null;
  /** Event-markets with a consensus overround. */
  consensusN: number;
  consensusMean: number | null;
}

export interface EdgeStats {
  n: number;
  mean: number | null;
  median: number | null;
  /** Share of selections with edge > 0 (we pay more than the reference's fair price). */
  shareAboveZero: number | null;
}

export interface BestPriceStats {
  n: number;
  /** Share where our price is above the best price of every book (arbitrage risk). */
  shareAbove: number | null;
  shareAtLeast: number | null;
}

export interface Section {
  sample: Sample;
  oneXTwo: { oursVsConsensus: Matched3; withPinnacle: MatchedWithPinnacle };
  overUnder: { oursVsConsensus: Matched2; withPinnacle: MatchedWithPinnacle2 };
  calibration: CalibrationBin[];
  prices: {
    overround: { oneXTwo: OverroundMeans; overUnder: OverroundMeans };
    edgeVsPinnacle: EdgeStats;
    edgeVsConsensus: EdgeStats;
    bestPrice: BestPriceStats;
  };
}

export interface Scorecard {
  overall: Section;
  byCompetition: { competition: string; section: Section }[];
  byPricingSource: { source: string; section: Section }[];
}

// ---------------------------------------------------------------- small helpers

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function medianOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list === undefined) groups.set(k, [item]);
    else list.push(item);
  }
  return groups;
}

/** Normalises positive weights to sum 1; null when one is missing or the sum is not positive. */
function normalised<T extends readonly (number | null)[]>(weights: T): number[] | null {
  let sum = 0;
  for (const w of weights) {
    if (w === null || !(w >= 0)) return null;
    sum += w;
  }
  return sum > 0 ? weights.map((w) => (w ?? 0) / sum) : null;
}

type Pick = (row: StoredClosePrice) => number | null;
const oursImplied: Pick = (r) =>
  r.ourOddsMilli !== null && r.ourOddsMilli > 0 ? 1000 / r.ourOddsMilli : null;
const consensusProb: Pick = (r) => (r.consensusPpm === null ? null : r.consensusPpm / PPM);
const pinnacleProb: Pick = (r) => (r.pinnaclePpm === null ? null : r.pinnaclePpm / PPM);

/** The event's probabilities for `selections` of one market, normalised; null if any is missing. */
function forecast(
  rows: readonly StoredClosePrice[],
  market: '1x2' | 'ou',
  selections: readonly string[],
  pick: Pick,
): number[] | null {
  const values = selections.map((selection) => {
    const row = rows.find(
      (r) =>
        r.market === market &&
        r.selection === selection &&
        (market === '1x2' ? r.line === null : r.line === OU_LINE),
    );
    return row === undefined ? null : pick(row);
  });
  return normalised(values);
}

// ---------------------------------------------------------------- one group of rows

interface Settled {
  rows: StoredClosePrice[];
  outcome: Outcome;
  over: boolean;
}

const mean3 = (scores: readonly (readonly [number, number, number])[]): Score3 | null =>
  scores.length === 0
    ? null
    : {
        brier: meanOrNull(scores.map((s) => s[0])) ?? 0,
        logLoss: meanOrNull(scores.map((s) => s[1])) ?? 0,
        rps: meanOrNull(scores.map((s) => s[2])) ?? 0,
      };

const mean2 = (scores: readonly (readonly [number, number])[]): Score2 | null =>
  scores.length === 0
    ? null
    : {
        brier: meanOrNull(scores.map((s) => s[0])) ?? 0,
        logLoss: meanOrNull(scores.map((s) => s[1])) ?? 0,
      };

const score3 = (p: number[], o: Outcome): [number, number, number] => {
  const probs = p as unknown as Probs3;
  return [brier3(probs, o), logLoss3(probs, o), rps3(probs, o)];
};

const score2 = (p: number[], over: boolean): [number, number] => {
  const pOver = p[0] ?? 0;
  return [brier2(pOver, over), logLoss2(pOver, over)];
};

const relative = (ours: number | undefined, reference: number | undefined): number | null =>
  ours === undefined || reference === undefined || reference <= 0 ? null : ours / reference - 1;

function oneXTwoScores(settled: readonly Settled[]): Section['oneXTwo'] {
  const SEL = ['1', 'X', '2'];
  const a = { ours: [] as [number, number, number][], consensus: [] as [number, number, number][] };
  const b = {
    ours: [] as [number, number, number][],
    consensus: [] as [number, number, number][],
    pinnacle: [] as [number, number, number][],
  };
  for (const s of settled) {
    const ours = forecast(s.rows, '1x2', SEL, oursImplied);
    const consensus = forecast(s.rows, '1x2', SEL, consensusProb);
    const pinnacle = forecast(s.rows, '1x2', SEL, pinnacleProb);
    if (ours === null || consensus === null) continue;
    a.ours.push(score3(ours, s.outcome));
    a.consensus.push(score3(consensus, s.outcome));
    if (pinnacle === null) continue;
    b.ours.push(score3(ours, s.outcome));
    b.consensus.push(score3(consensus, s.outcome));
    b.pinnacle.push(score3(pinnacle, s.outcome));
  }
  const bOurs = mean3(b.ours);
  const bPinnacle = mean3(b.pinnacle);
  return {
    oursVsConsensus: { n: a.ours.length, ours: mean3(a.ours), consensus: mean3(a.consensus) },
    withPinnacle: {
      n: b.ours.length,
      ours: bOurs,
      consensus: mean3(b.consensus),
      pinnacle: bPinnacle,
      relLogLossVsPinnacle: relative(bOurs?.logLoss, bPinnacle?.logLoss),
    },
  };
}

function overUnderScores(settled: readonly Settled[]): Section['overUnder'] {
  const SEL = ['over', 'under'];
  const a = { ours: [] as [number, number][], consensus: [] as [number, number][] };
  const b = {
    ours: [] as [number, number][],
    consensus: [] as [number, number][],
    pinnacle: [] as [number, number][],
  };
  for (const s of settled) {
    const ours = forecast(s.rows, 'ou', SEL, oursImplied);
    const consensus = forecast(s.rows, 'ou', SEL, consensusProb);
    const pinnacle = forecast(s.rows, 'ou', SEL, pinnacleProb);
    if (ours === null || consensus === null) continue;
    a.ours.push(score2(ours, s.over));
    a.consensus.push(score2(consensus, s.over));
    if (pinnacle === null) continue;
    b.ours.push(score2(ours, s.over));
    b.consensus.push(score2(consensus, s.over));
    b.pinnacle.push(score2(pinnacle, s.over));
  }
  const bOurs = mean2(b.ours);
  const bPinnacle = mean2(b.pinnacle);
  return {
    oursVsConsensus: { n: a.ours.length, ours: mean2(a.ours), consensus: mean2(a.consensus) },
    withPinnacle: {
      n: b.ours.length,
      ours: bOurs,
      consensus: mean2(b.consensus),
      pinnacle: bPinnacle,
      relLogLossVsPinnacle: relative(bOurs?.logLoss, bPinnacle?.logLoss),
    },
  };
}

/** Our fair 1X2 probabilities in ten bins, every selection of every scored event. */
function calibrationOf(settled: readonly Settled[]): CalibrationBin[] {
  const counts = new Array<number>(CALIBRATION_BINS).fill(0);
  const predicted = new Array<number>(CALIBRATION_BINS).fill(0);
  const hits = new Array<number>(CALIBRATION_BINS).fill(0);
  for (const s of settled) {
    const ours = forecast(s.rows, '1x2', ['1', 'X', '2'], oursImplied);
    if (ours === null) continue;
    ours.forEach((p, k) => {
      const bin = Math.min(CALIBRATION_BINS - 1, Math.floor(p * CALIBRATION_BINS));
      counts[bin] = (counts[bin] ?? 0) + 1;
      predicted[bin] = (predicted[bin] ?? 0) + p;
      hits[bin] = (hits[bin] ?? 0) + (k === s.outcome ? 1 : 0);
    });
  }
  return counts.map((n, b) => ({
    bin: `${(b / CALIBRATION_BINS).toFixed(1)}-${((b + 1) / CALIBRATION_BINS).toFixed(1)}`,
    n,
    meanPredicted: n === 0 ? null : (predicted[b] ?? 0) / n,
    observed: n === 0 ? null : (hits[b] ?? 0) / n,
  }));
}

function overroundOf(rows: readonly StoredClosePrice[], market: '1x2' | 'ou'): OverroundMeans {
  const selections = market === '1x2' ? ['1', 'X', '2'] : ['over', 'under'];
  const inMarket = rows.filter(
    (r) => r.market === market && (market === '1x2' ? r.line === null : r.line === OU_LINE),
  );
  const ours: number[] = [];
  const consensus: number[] = [];
  for (const eventRows of groupBy(inMarket, (r) => r.eventId).values()) {
    const implied = selections.map((selection) => {
      const row = eventRows.find((r) => r.selection === selection);
      return row === undefined ? null : oursImplied(row);
    });
    if (implied.every((v): v is number => v !== null))
      ours.push(implied.reduce((a, b) => a + b, 0));
    const overround = eventRows.find((r) => r.overroundPpm !== null)?.overroundPpm;
    if (overround !== undefined && overround !== null) consensus.push(overround / PPM);
  }
  return {
    oursN: ours.length,
    oursMean: meanOrNull(ours),
    consensusN: consensus.length,
    consensusMean: meanOrNull(consensus),
  };
}

/** Bettor edge of our price against a fair probability: odds x p - 1. */
function edgeOf(rows: readonly StoredClosePrice[], fair: Pick): EdgeStats {
  const edges: number[] = [];
  for (const r of rows) {
    const p = fair(r);
    if (r.ourOddsMilli !== null && p !== null) edges.push((r.ourOddsMilli / 1000) * p - 1);
  }
  return {
    n: edges.length,
    mean: meanOrNull(edges),
    median: medianOrNull(edges),
    shareAboveZero: edges.length === 0 ? null : edges.filter((e) => e > 0).length / edges.length,
  };
}

function bestPriceOf(rows: readonly StoredClosePrice[]): BestPriceStats {
  let n = 0;
  let above = 0;
  let atLeast = 0;
  for (const r of rows) {
    if (r.ourOddsMilli === null || r.bestOddsMilli === null) continue;
    n++;
    if (r.ourOddsMilli > r.bestOddsMilli) above++;
    if (r.ourOddsMilli >= r.bestOddsMilli) atLeast++;
  }
  return {
    n,
    shareAbove: n === 0 ? null : above / n,
    shareAtLeast: n === 0 ? null : atLeast / n,
  };
}

/** The scorecard of one group of captured rows. */
export function computeSection(
  rows: readonly StoredClosePrice[],
  events: ReadonlyMap<string, ClosePriceEvent>,
): Section {
  const sample: Sample = { events: 0, settled: 0, void: 0, pending: 0 };
  const settled: Settled[] = [];
  for (const [eventId, eventRows] of groupBy(rows, (r) => r.eventId)) {
    sample.events++;
    const event = events.get(eventId);
    if (event !== undefined && VOID_STATUSES.has(event.status)) sample.void++;
    else if (
      event !== undefined &&
      event.status === 'finished' &&
      event.scoreHome !== null &&
      event.scoreAway !== null
    ) {
      sample.settled++;
      settled.push({
        rows: eventRows,
        outcome: outcomeOf(event.scoreHome, event.scoreAway),
        over: event.scoreHome + event.scoreAway > 2.5,
      });
    } else sample.pending++;
  }
  return {
    sample,
    oneXTwo: oneXTwoScores(settled),
    overUnder: overUnderScores(settled),
    calibration: calibrationOf(settled),
    prices: {
      overround: { oneXTwo: overroundOf(rows, '1x2'), overUnder: overroundOf(rows, 'ou') },
      edgeVsPinnacle: edgeOf(rows, pinnacleProb),
      edgeVsConsensus: edgeOf(rows, consensusProb),
      bestPrice: bestPriceOf(rows),
    },
  };
}

/** The scorecard overall, per competition and per pricing source (model / market). */
export function computeScorecard(
  rows: readonly StoredClosePrice[],
  eventList: readonly ClosePriceEvent[],
): Scorecard {
  const events = new Map(eventList.map((e) => [e.eventId, e]));
  const competitionOf = (r: StoredClosePrice): string =>
    events.get(r.eventId)?.competitionName ?? '(unknown)';
  const byName = (a: { key: string }, b: { key: string }): number =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  return {
    overall: computeSection(rows, events),
    byCompetition: [...groupBy(rows, competitionOf)]
      .map(([key, group]) => ({ key, competition: key, section: computeSection(group, events) }))
      .sort(byName)
      .map(({ competition, section }) => ({ competition, section })),
    byPricingSource: [...groupBy(rows, (r) => r.pricingSource)]
      .map(([key, group]) => ({ key, source: key, section: computeSection(group, events) }))
      .sort(byName)
      .map(({ source, section }) => ({ source, section })),
  };
}

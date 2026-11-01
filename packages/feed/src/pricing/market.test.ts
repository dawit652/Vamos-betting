import {
  MAX_ODDS_MILLI,
  MIN_ODDS_MILLI,
  type MarketConsensus,
  type MarketPriceRow,
  isValidOddsMilli,
  marketConsensus,
  selectionsFor,
} from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { type Rng, createRng } from '../random';
import type { FeedMarket } from '../types';
import { bookOverround, buildMarket } from './book';
import { MAX_EXPECTED_GOALS, MIN_EXPECTED_GOALS, footballBooks, priceFootball } from './football';
import {
  MARKET_PRICING_KEY_PREFIX,
  MAX_MARKET_FIT_RESIDUAL,
  fitGoalsToMarket,
  marketPricingKey,
  priceFootballFromMarket,
} from './market';

/**
 * The market sanity check of the scraper's gates (checkMarkets in
 * @vamos/scraper, rule O2), replicated because @vamos/feed cannot depend on
 * the scraper: every book's overround divided by the times its selections
 * cover each outcome (2 for double chance) is within [1.01, 1.3].
 */
const GATE_OVERROUND_MIN = 1.01;
const GATE_OVERROUND_MAX = 1.3;

function consensusOf(
  x12: readonly [number, number, number],
  over?: number,
  books = 8,
  line = '2.5',
): MarketConsensus[] {
  const out: MarketConsensus[] = [
    {
      market: '1x2',
      line: null,
      probabilities: { '1': x12[0], X: x12[1], '2': x12[2] },
      books,
      overroundMedian: 1.05,
    },
  ];
  if (over !== undefined) {
    out.push({
      market: 'ou',
      line,
      probabilities: { over, under: 1 - over },
      books: books - 1,
      overroundMedian: 1.06,
    });
  }
  return out;
}

function key(market: FeedMarket): string {
  return market.line === null ? market.type : `${market.type}:${market.line}`;
}

function find(markets: FeedMarket[], type: string, line: string | null = null): FeedMarket {
  const market = markets.find((m) => m.type === type && m.line === line);
  if (market === undefined) throw new Error(`market ${type} ${line ?? ''} not offered`);
  return market;
}

/** Bookmakers' rows for the 1X2 and the 2.5 line of priceFootball(λh, λa) at several margins. */
function bookmakerRows(lambdaHome: number, lambdaAway: number): MarketPriceRow[] {
  const rows: MarketPriceRow[] = [];
  for (const [bookmaker, marginBps] of [
    ['a', 400],
    ['b', 550],
    ['c', 700],
    ['d', 900],
  ] as const) {
    for (const market of priceFootball(lambdaHome, lambdaAway, { marginBps, lines: ['2.5'] })) {
      if (market.type !== '1x2' && market.type !== 'ou') continue;
      for (const s of market.selections) {
        rows.push({
          bookmaker,
          market: market.type,
          line: market.line,
          selection: s.code,
          priceMilli: s.oddsMilli,
        });
      }
    }
  }
  return rows;
}

/** Goal lines in place of 2.5, with a plausible range of the over probability. */
const OTHER_LINES = [
  ['1.5', 0.55, 0.9],
  ['3.5', 0.15, 0.55],
  ['4.5', 0.05, 0.35],
] as const;

/**
 * A plausible consensus: 1X2 with no outcome above 0.85, and one goal line: over 2.5 in
 * [0.25, 0.8] four times in five, else 1.5, 3.5 or 4.5 (rule T1).
 */
function randomConsensus(rng: Rng): MarketConsensus[] {
  for (;;) {
    const w = [0.3 + rng.next() * 5, 0.6 + rng.next() * 1.2, 0.3 + rng.next() * 5];
    const total = w[0]! + w[1]! + w[2]!;
    const p = w.map((x) => x / total) as [number, number, number];
    if (Math.max(...p) > 0.85) continue;
    if (rng.next() < 0.8) return consensusOf(p, 0.25 + rng.next() * 0.55);
    const [line, low, high] = OTHER_LINES[Math.floor(rng.next() * OTHER_LINES.length)]!;
    return consensusOf(p, low + rng.next() * (high - low), 8, line);
  }
}

const EPL: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.45, 0.26, 0.29, 0.54],
  [0.7, 0.18, 0.12, 0.62],
  [0.36, 0.27, 0.37, 0.5],
  [0.25, 0.25, 0.5, 0.55],
  [0.55, 0.24, 0.21, 0.58],
  [0.4, 0.29, 0.31, 0.45],
  [0.8, 0.13, 0.07, 0.7],
  [0.33, 0.3, 0.37, 0.42],
];

describe('fitGoalsToMarket', () => {
  it('recovers the expected goals the prices were made from (round trip, property)', () => {
    const rng = createRng('market-fit-round-trip');
    const grid = [0.5, 0.8, 1.1, 1.4, 1.8, 2.3, 2.8];
    const pairs = [
      ...grid.flatMap((lh) => grid.map((la) => [lh, la] as const)),
      ...Array.from(
        { length: 40 },
        () => [0.5 + rng.next() * 2.3, 0.5 + rng.next() * 2.3] as const,
      ),
    ];
    let worst = 0;
    for (const [lh, la] of pairs) {
      const consensus = marketConsensus(bookmakerRows(lh, la));
      expect(consensus.map((c) => c.books)).toEqual([4, 4]);
      const fit = fitGoalsToMarket(consensus)!;
      const error = Math.max(Math.abs(fit.lambdaHome / lh - 1), Math.abs(fit.lambdaAway / la - 1));
      worst = Math.max(worst, error);
      // Prices are rounded to whole hundredths, so the targets are only that exact.
      expect(error).toBeLessThan(0.03);
      expect(fit.residual).toBeLessThan(0.005);
    }
    expect(worst).toBeGreaterThan(0);
  });

  it('matches a consensus the model can produce exactly', () => {
    const exact = priceFootball(1.7, 0.9, { marginBps: 0 });
    // A 1X2 alone: two targets, two unknowns.
    const probabilities = (m: FeedMarket) => m.selections.map((s) => 1000 / s.oddsMilli);
    const p = probabilities(find(exact, '1x2'));
    const total = p[0]! + p[1]! + p[2]!;
    const fit = fitGoalsToMarket(consensusOf([p[0]! / total, p[1]! / total, p[2]! / total]))!;
    expect(fit.residual).toBeLessThan(1e-9);
  });

  it('fits typical Premier League markets within MAX_MARKET_FIT_RESIDUAL', () => {
    expect(MAX_MARKET_FIT_RESIDUAL).toBe(0.03);
    for (const [h, d, a, over] of EPL) {
      const fit = fitGoalsToMarket(consensusOf([h, d, a], over))!;
      expect(fit.residual).toBeLessThan(0.015);
      // Without the 2.5 line the 1X2 is matched exactly, draw included.
      expect(fitGoalsToMarket(consensusOf([h, d, a]))!.residual).toBeLessThan(1e-9);
    }
  });

  it('reports a poor fit when the market is out of the model’s reach', () => {
    // A 60% draw with three goals expected: no pair of Poisson means does both.
    const fit = fitGoalsToMarket(consensusOf([0.2, 0.6, 0.2], 0.75))!;
    expect(fit.residual).toBeGreaterThan(MAX_MARKET_FIT_RESIDUAL);
  });

  it('stays within the expected-goals bounds (property)', () => {
    const rng = createRng('market-fit-bounds');
    for (let i = 0; i < 60; i++) {
      const w = [rng.next() * 20 + 0.01, rng.next() * 5 + 0.01, rng.next() * 20 + 0.01];
      const total = w[0]! + w[1]! + w[2]!;
      const fit = fitGoalsToMarket(
        consensusOf([w[0]! / total, w[1]! / total, w[2]! / total], 0.01 + rng.next() * 0.98),
      )!;
      for (const lambda of [fit.lambdaHome, fit.lambdaAway]) {
        expect(lambda).toBeGreaterThanOrEqual(MIN_EXPECTED_GOALS);
        expect(lambda).toBeLessThanOrEqual(MAX_EXPECTED_GOALS);
      }
      expect(Number.isFinite(fit.residual)).toBe(true);
    }
  });

  it('returns null without a usable 1X2', () => {
    expect(fitGoalsToMarket([])).toBeNull();
    expect(fitGoalsToMarket(consensusOf([0.5, 0.3, 0.2], 0.5).slice(1))).toBeNull();
    expect(fitGoalsToMarket(consensusOf([0.7, 0.3, 0]))).toBeNull();
    expect(fitGoalsToMarket(consensusOf([Number.NaN, 0.3, 0.2]))).toBeNull();
  });
});

describe('priceFootballFromMarket', () => {
  const consensus = consensusOf([0.45, 0.26, 0.29], 0.54);
  const priced = priceFootballFromMarket(consensus)!;

  it('offers the same markets, in the same order and shape, as priceFootball', () => {
    const model = priceFootball(priced.lambdaHome, priced.lambdaAway);
    expect(priced.markets.map(key)).toEqual(model.map(key));
    for (const market of priced.markets) {
      expect(market.selections.map((s) => s.code)).toEqual([...selectionsFor(market.type)]);
    }
    const lines = ['1.5', '2.5', '5.5'];
    const custom = priceFootballFromMarket(consensus, { lines })!;
    expect(custom.markets.map(key)).toEqual(
      priceFootball(custom.lambdaHome, custom.lambdaAway, { lines }).map(key),
    );
    expect(priced.source).toEqual({ books1x2: 8, booksOu25: 7 });
    expect(priced.totalsLine).toBe('2.5');
  });

  it('prices the 1X2, double chance, draw no bet and the 2.5 line from the consensus', () => {
    const [h, d, a] = [0.45, 0.26, 0.29];
    expect(find(priced.markets, '1x2')).toEqual(
      buildMarket('1x2', null, { '1': h, X: d, '2': a }, 600),
    );
    expect(find(priced.markets, 'dc')).toEqual(
      buildMarket('dc', null, { '1X': h + d, '12': h + a, X2: d + a }, 600),
    );
    expect(find(priced.markets, 'dnb')).toEqual(
      buildMarket('dnb', null, { '1': h / (h + a), '2': a / (h + a) }, 600),
    );
    expect(find(priced.markets, 'ou', '2.5')).toEqual(
      buildMarket('ou', '2.5', { over: 0.54, under: 0.46 }, 600),
    );
  });

  it('prices every other market from the fitted expected goals, exactly as priceFootball', () => {
    const model = priceFootball(priced.lambdaHome, priced.lambdaAway);
    for (const market of priced.markets) {
      if (['1x2', 'dc', 'dnb'].includes(market.type) || key(market) === 'ou:2.5') continue;
      expect(market).toEqual(find(model, market.type, market.line));
    }
    // Without a 2.5 consensus the 2.5 line comes from the model too, fitted to the line in its place.
    const other = priceFootballFromMarket(consensusOf([0.45, 0.26, 0.29], 0.3, 8, '3.5'))!;
    expect(other.totalsLine).toBe('3.5');
    expect(find(other.markets, 'ou', '2.5')).toEqual(
      find(priceFootball(other.lambdaHome, other.lambdaAway), 'ou', '2.5'),
    );
    expect(other.source).toEqual({ books1x2: 8, booksOu25: 0 });
  });

  it('keeps the consensus 1X2 once our margin is removed (within the rounding of odds)', () => {
    const rng = createRng('market-1x2-demargin');
    for (let i = 0; i < 150; i++) {
      const input = randomConsensus(rng);
      const market = find(priceFootballFromMarket(input)!.markets, '1x2');
      const implied = market.selections.map((s) => 1000 / s.oddsMilli);
      const total = implied.reduce((x, y) => x + y, 0);
      // One price step (a hundredth) of every selection, in implied probability.
      const tolerance = market.selections.reduce((t, s) => t + 10_000 / s.oddsMilli ** 2, 0);
      market.selections.forEach((s, k) => {
        expect(Math.abs(implied[k]! / total - input[0]!.probabilities[s.code]!)).toBeLessThan(
          tolerance,
        );
      });
    }
  });

  it('prices sound books that pass the market sanity check (property)', () => {
    const rng = createRng('market-sound-books');
    for (let i = 0; i < 150; i++) {
      const result = priceFootballFromMarket(randomConsensus(rng))!;
      expect(result.markets.length).toBeGreaterThan(0);
      for (const market of result.markets) {
        for (const s of market.selections) {
          expect(Number.isSafeInteger(s.oddsMilli)).toBe(true);
          expect(isValidOddsMilli(s.oddsMilli)).toBe(true);
          expect(s.oddsMilli).toBeGreaterThanOrEqual(MIN_ODDS_MILLI);
          expect(s.oddsMilli).toBeLessThanOrEqual(MAX_ODDS_MILLI);
        }
        const cover = market.type === 'dc' ? 2 : 1;
        expect(bookOverround(market) / cover).toBeGreaterThanOrEqual(GATE_OVERROUND_MIN);
        expect(bookOverround(market) / cover).toBeLessThanOrEqual(GATE_OVERROUND_MAX);
      }
    }
  });

  it('applies the margin options', () => {
    const fair = priceFootballFromMarket(consensus, { marginBps: 0, correctScoreMarginBps: 0 })!;
    expect(bookOverround(find(fair.markets, '1x2'))).toBeLessThan(1.01);
    const wide = priceFootballFromMarket(consensus, {
      marginBps: 1000,
      correctScoreMarginBps: 2000,
    })!;
    expect(Math.abs(bookOverround(find(wide.markets, '1x2')) - 1.1)).toBeLessThan(0.005);
    expect(Math.abs(bookOverround(find(wide.markets, 'cs')) - 1.2)).toBeLessThan(0.005);
    expect(() => priceFootballFromMarket(consensus, { marginBps: -1 })).toThrow(RangeError);
    expect(() => priceFootballFromMarket(consensus, { lines: ['2'] })).toThrow(RangeError);
  });

  it('is deterministic and leaves its input alone', () => {
    const input = consensusOf([0.36, 0.27, 0.37], 0.5);
    const copy = structuredClone(input);
    const first = priceFootballFromMarket(input);
    expect(priceFootballFromMarket(input)).toEqual(first);
    expect(input).toEqual(copy);
    expect(fitGoalsToMarket(input)).toEqual(fitGoalsToMarket(copy));
  });

  it('returns null without a usable 1X2, or without a goal line to fit the goals to (rule T2)', () => {
    expect(priceFootballFromMarket([])).toBeNull();
    expect(priceFootballFromMarket(consensusOf([0.5, 0.3, 0.2], 0.5).slice(1))).toBeNull();
    expect(priceFootballFromMarket(consensusOf([1, 0, 0]))).toBeNull();
    expect(priceFootballFromMarket(consensusOf([0.45, 0.26, 0.29]))).toBeNull();
    expect(priceFootballFromMarket(consensusOf([0.45, 0.26, 0.29], 0.97, 8, '0.5'))).toBeNull();
  });
});

describe('marketPricingKey', () => {
  it('is a short fingerprint of the rounded 1X2 and 2.5 consensus and their books', () => {
    expect(marketPricingKey(consensusOf([0.45, 0.26, 0.29], 0.54))).toBe(
      `${MARKET_PRICING_KEY_PREFIX}|1x2:450,260,290/8|ou2.5:540/7`,
    );
    expect(marketPricingKey(consensusOf([0.45, 0.26, 0.29]))).toBe(
      'mkt1|1x2:450,260,290/8|ou2.5:-',
    );
    // The line fitted in place of a missing 2.5 (rule T1).
    expect(marketPricingKey(consensusOf([0.45, 0.26, 0.29], 0.3, 8, '3.5'))).toBe(
      'mkt1|1x2:450,260,290/8|ou3.5:300/7',
    );
    expect(marketPricingKey([])).toBe('mkt1|none');
  });

  it('ignores tiny moves and notices real ones', () => {
    const base = marketPricingKey(consensusOf([0.451, 0.26, 0.289], 0.541));
    expect(marketPricingKey(consensusOf([0.4515, 0.2595, 0.289], 0.5405))).toBe(base);
    expect(marketPricingKey(consensusOf([0.461, 0.25, 0.289], 0.541))).not.toBe(base);
    expect(marketPricingKey(consensusOf([0.451, 0.26, 0.289], 0.561))).not.toBe(base);
    expect(marketPricingKey(consensusOf([0.451, 0.26, 0.289], 0.541, 9))).not.toBe(base);
  });

  it('does not depend on markets that do not change our prices, nor on their order', () => {
    const input = consensusOf([0.45, 0.26, 0.29], 0.54);
    const other: MarketConsensus = {
      market: 'ou',
      line: '3.5',
      probabilities: { over: 0.3, under: 0.7 },
      books: 5,
      overroundMedian: 1.05,
    };
    expect(marketPricingKey([other, ...input].reverse())).toBe(marketPricingKey(input));
  });
});

describe('the goal line in place of 2.5 (rules T1 and T2)', () => {
  const ou = (line: string, over: number, books = 5): MarketConsensus => ({
    market: 'ou',
    line,
    probabilities: { over, under: 1 - over },
    books,
    overroundMedian: 1.05,
  });
  const overOf = (lh: number, la: number, line: string): number =>
    footballBooks(lh, la, { lines: [line] }).find((b) => b.type === 'ou')!.probabilities.over!;
  /** The model's 1X2 at (λh, λa) with the draw raised by `bump`, taken from home and away pro rata. */
  const withDrawPremium = (lh: number, la: number, bump: number): MarketConsensus[] => {
    const p = footballBooks(lh, la, { lines: ['2.5'] })[0]!.probabilities;
    const s = p['1']! + p['2']!;
    return consensusOf([
      p['1']! - (bump * p['1']!) / s,
      p.X! + bump,
      p['2']! - (bump * p['2']!) / s,
    ]);
  };

  it('puts the goals back with a 1.5 or 3.5 line; a 1X2 alone gets no market prices', () => {
    // docs/theoddsapi-plan/README.md 10.3: markets with F-17's draw premium of 1.7 points.
    const cases = [
      [1.4, 1.35],
      [1.6, 1.1],
      [2.1, 0.8],
      [1.15, 1.05],
      [1.9, 1.5],
    ] as const;
    for (const [lh, la] of cases) {
      const x12 = withDrawPremium(lh, la, 0.017);
      const alone = fitGoalsToMarket(x12)!;
      expect(alone.totalsLine).toBeNull();
      // The bias rule T2 refuses: over 2.5 more than four points short.
      expect(overOf(alone.lambdaHome, alone.lambdaAway, '2.5')).toBeLessThan(
        overOf(lh, la, '2.5') - 0.04,
      );
      expect(priceFootballFromMarket(x12)).toBeNull();
      for (const line of ['1.5', '3.5']) {
        const input = [...x12, ou(line, overOf(lh, la, line))];
        const fit = fitGoalsToMarket(input)!;
        expect(fit.totalsLine).toBe(line);
        expect(fit.residual).toBeLessThan(MAX_MARKET_FIT_RESIDUAL);
        expect(Math.abs(fit.lambdaHome + fit.lambdaAway - (lh + la))).toBeLessThan(0.05);
        expect(
          Math.abs(overOf(fit.lambdaHome, fit.lambdaAway, '2.5') - overOf(lh, la, '2.5')),
        ).toBeLessThan(0.01);
        const priced = priceFootballFromMarket(input)!;
        expect(priced.totalsLine).toBe(line);
        expect(priced.source.booksOu25).toBe(0);
      }
    }
  });

  it('recovers the expected goals of a model market from any set of its x.5 lines (property)', () => {
    const rng = createRng('market-fit-any-line');
    const lines = ['1.5', '2.5', '3.5', '4.5'];
    const subsets = Array.from({ length: 15 }, (_, mask) =>
      lines.filter((_, i) => ((mask + 1) >> i) & 1),
    );
    const grid = [0.5, 1.0, 1.6, 2.4];
    const pairs = [
      ...grid.flatMap((lh) => grid.map((la) => [lh, la] as const)),
      ...Array.from(
        { length: 12 },
        () => [0.5 + rng.next() * 2.3, 0.5 + rng.next() * 2.3] as const,
      ),
    ];
    for (const [lh, la] of pairs) {
      const p = footballBooks(lh, la, { lines: ['2.5'] })[0]!.probabilities;
      const x12 = consensusOf([p['1']!, p.X!, p['2']!]);
      for (const subset of subsets) {
        const fit = fitGoalsToMarket([...x12, ...subset.map((l) => ou(l, overOf(lh, la, l)))])!;
        // 2.5 when it is there; else all lines have 5 books: the nearest to 2.5, the lower first.
        const expected = ['2.5', '1.5', '3.5', '4.5'].find((l) => subset.includes(l));
        expect(fit.totalsLine).toBe(expected);
        expect(Math.abs(fit.lambdaHome - lh)).toBeLessThan(0.01);
        expect(Math.abs(fit.lambdaAway - la)).toBeLessThan(0.01);
        expect(fit.residual).toBeLessThan(1e-6);
      }
    }
  });

  it('picks the most books, then the nearest to 2.5, then the lower; x.5 lines 1.5 to 4.5 only', () => {
    const x12 = consensusOf([0.45, 0.26, 0.29]);
    const lineOf = (...lines: MarketConsensus[]) =>
      fitGoalsToMarket([...x12, ...lines])!.totalsLine;
    expect(lineOf(ou('1.5', 0.75, 3), ou('3.5', 0.3, 5))).toBe('3.5');
    expect(lineOf(ou('4.5', 0.15, 6), ou('3.5', 0.3, 4))).toBe('4.5');
    expect(lineOf(ou('3.5', 0.3, 5), ou('1.5', 0.75, 5))).toBe('1.5');
    expect(lineOf(ou('4.5', 0.15, 4), ou('3.5', 0.3, 4))).toBe('3.5');
    expect(lineOf(ou('3.5', 0.3, 9), ou('2.5', 0.55, 2))).toBe('2.5');
    expect(
      lineOf(ou('0.5', 0.95, 9), ou('5.5', 0.03, 9), ou('2.75', 0.45, 9), ou('3', 0.4, 9)),
    ).toBeNull();
    // Unusable probabilities or no books.
    expect(lineOf(ou('3.5', 0, 9), ou('1.5', 0.75, 0))).toBeNull();
  });

  it('changes nothing for a consensus that has the 2.5 line', () => {
    const base = consensusOf([0.45, 0.26, 0.29], 0.54);
    const more = [ou('3.5', 0.3, 9), ...base, ou('1.5', 0.8, 9)];
    expect(fitGoalsToMarket(more)).toEqual(fitGoalsToMarket(base));
    expect(priceFootballFromMarket(more)).toEqual(priceFootballFromMarket(base));
    expect(marketPricingKey(more)).toBe(marketPricingKey(base));
  });
});

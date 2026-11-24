import { selectionsFor, type MarketTypeCode } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bookOverround, DEFAULT_MARGIN_BPS } from './book';
import {
  BOARD_CONSENSUS_BOOKMAKER,
  boardConsensus,
  boardGoalsFit,
  MAX_BOARD_OVERROUND,
  priceBoardMarket,
  priceBoardMarkets,
  type BoardMarketInput,
} from './board';
import { footballBooks } from './football';

/** Prices of the Netherlands v Greece board of 13 Nov 2026 (packages/scraper fixture). */
const X12: BoardMarketInput = {
  type: '1x2',
  line: null,
  prices: [
    { code: '1', priceMilli: 1480 },
    { code: 'X', priceMilli: 4700 },
    { code: '2', priceMilli: 5800 },
  ],
};

const implied = (market: { selections: Array<{ oddsMilli: number }> }) =>
  market.selections.map((s) => 1000 / s.oddsMilli);

describe('priceBoardMarket', () => {
  it("replaces the board's margin with ours and keeps its view of the match", () => {
    const board = X12.prices.map((p) => 1000 / p.priceMilli);
    const boardTotal = board.reduce((a, b) => a + b, 0);
    expect(boardTotal).toBeGreaterThan(1.05); // Hulusport's own margin, about 7%
    const ours = priceBoardMarket(X12)!;
    expect(ours.selections.map((s) => s.code)).toEqual(['1', 'X', '2']);
    // Our overround is our margin (6%), give or take the rounding of the prices.
    expect(bookOverround(ours)).toBeGreaterThan(1 + DEFAULT_MARGIN_BPS / 10_000 - 0.01);
    expect(bookOverround(ours)).toBeLessThan(1 + DEFAULT_MARGIN_BPS / 10_000 + 0.01);
    // Same order of likelihood as the board, and close to its fair probabilities.
    const fair = board.map((p) => p / boardTotal);
    implied(ours).forEach((p, i) => {
      expect(p).toBeGreaterThanOrEqual(fair[i]!);
      expect(p).toBeLessThan(fair[i]! * 1.1);
    });
  });

  it('prices double chance against a fair total of 2', () => {
    const dc = priceBoardMarket({
      type: 'dc',
      line: null,
      prices: [
        { code: '1X', priceMilli: 1110 },
        { code: '12', priceMilli: 1200 },
        { code: 'X2', priceMilli: 2500 },
      ],
    })!;
    expect(dc).not.toBeNull();
    const total = bookOverround(dc);
    expect(total).toBeGreaterThan(2);
    expect(total).toBeLessThan(2 * 1.08);
  });

  it('keeps a line market on its canonical line', () => {
    const ou = priceBoardMarket({
      type: 'ou',
      line: '2.5',
      prices: [
        { code: 'over', priceMilli: 1900 },
        { code: 'under', priceMilli: 1850 },
      ],
    })!;
    expect(ou.line).toBe('2.5');
    const eh = priceBoardMarket({
      type: 'eh',
      line: '-1',
      prices: [
        { code: '1', priceMilli: 2070 },
        { code: 'X', priceMilli: 3650 },
        { code: '2', priceMilli: 2420 },
      ],
    })!;
    expect(eh.line).toBe('-1');
  });

  it('leaves out a market that is not a complete, sane book', () => {
    const bad: BoardMarketInput[] = [
      { ...X12, prices: X12.prices.slice(0, 2) },
      { ...X12, prices: [...X12.prices, { code: '1', priceMilli: 1500 }] },
      { ...X12, prices: [X12.prices[0]!, X12.prices[1]!, { code: 'over', priceMilli: 5800 }] },
      { ...X12, prices: [X12.prices[0]!, X12.prices[1]!, { code: '2', priceMilli: 1000 }] },
      { ...X12, prices: [X12.prices[0]!, X12.prices[1]!, { code: '2', priceMilli: 5800.5 }] },
      { ...X12, line: '2.5' },
      {
        type: 'ou',
        line: '2.25',
        prices: [
          { code: 'over', priceMilli: 1900 },
          { code: 'under', priceMilli: 1900 },
        ],
      },
      {
        type: 'ou',
        line: null,
        prices: [
          { code: 'over', priceMilli: 1900 },
          { code: 'under', priceMilli: 1900 },
        ],
      },
      // Overround below 1: the board would pay out more than it takes.
      {
        ...X12,
        prices: [
          { code: '1', priceMilli: 2000 },
          { code: 'X', priceMilli: 5000 },
          { code: '2', priceMilli: 5000 },
        ],
      },
      // Overround far above the margin of any real book: a mapping error.
      {
        ...X12,
        prices: [
          { code: '1', priceMilli: 1100 },
          { code: 'X', priceMilli: 1500 },
          { code: '2', priceMilli: 2000 },
        ],
      },
      { type: 'nope' as MarketTypeCode, line: null, prices: [] },
    ];
    for (const market of bad) expect(priceBoardMarket(market)).toBeNull();
    expect(priceBoardMarkets([...bad, X12])).toHaveLength(1);
  });

  it('property: a usable book gets every selection of its type, never above its fair price', () => {
    const types: MarketTypeCode[] = ['1x2', 'ht_1x2', 'btts', 'dnb', 'dc', 'ou', 'eh'];
    fc.assert(
      fc.property(
        fc.constantFrom(...types),
        fc.array(fc.double({ min: 0.03, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 }),
        fc.double({ min: 0, max: 0.2, noNaN: true }),
        (type, weights, boardMargin) => {
          const codes = selectionsFor(type);
          const w = weights.slice(0, codes.length);
          const sum = w.reduce((a, b) => a + b, 0);
          // Fair probabilities of exclusive outcomes; double chance covers two of the three.
          let fair = w.map((x) => x / sum);
          if (type === 'dc') {
            const [p1, px, p2] = [
              weights[0]! / weights.reduce((a, b) => a + b, 0),
              weights[1]! / weights.reduce((a, b) => a + b, 0),
              weights[2]! / weights.reduce((a, b) => a + b, 0),
            ];
            fair = [p1 + px, p1 + p2, px + p2];
          }
          const prices = codes.map((code, i) => ({
            code,
            priceMilli: Math.max(
              1010,
              Math.min(1_000_000, Math.floor(1000 / (fair[i]! * (1 + boardMargin)))),
            ),
          }));
          const line = type === 'ou' ? '2.5' : type === 'eh' ? '-1' : null;
          const total = type === 'dc' ? 2 : 1;
          const boardOverround = prices.reduce((s, p) => s + 1000 / p.priceMilli, 0);
          const ours = priceBoardMarket({ type, line, prices });
          if (boardOverround < total || boardOverround > total * MAX_BOARD_OVERROUND) {
            expect(ours).toBeNull();
            return;
          }
          if (ours === null) return; // a selection too likely to be offered at all
          expect(ours.selections.map((s) => s.code)).toEqual([...codes]);
          // Never above the fair price the board's own book implies.
          const boardFair = prices.map((p) => ((1000 / p.priceMilli) * total) / boardOverround);
          ours.selections.forEach((s, i) => {
            expect(1000 / s.oddsMilli).toBeGreaterThanOrEqual(boardFair[i]! - 1e-12);
          });
          expect(bookOverround(ours)).toBeGreaterThanOrEqual(total - 1e-9);
        },
      ),
      { numRuns: 500 },
    );
  });
});

/** A board's book of `type`/`line` from the model's fair probabilities, with its margin (in bps). */
function boardBookFromModel(
  lambdaHome: number,
  lambdaAway: number,
  type: '1x2' | 'ou' | 'btts',
  line: string | null,
  marginBps = 700,
): BoardMarketInput {
  const book = footballBooks(lambdaHome, lambdaAway).find(
    (b) => b.type === type && b.line === line,
  )!;
  return {
    type,
    line,
    prices: Object.entries(book.probabilities).map(([code, p]) => ({
      code,
      priceMilli: Math.round(1000 / (p * (1 + marginBps / 10_000))),
    })),
  };
}

describe('boardGoalsFit (the factory on board-only matches)', () => {
  it('finds the expected goals behind a board 1X2 and over/under 2.5', () => {
    const board = [
      boardBookFromModel(1.7, 1.1, '1x2', null),
      boardBookFromModel(1.7, 1.1, 'ou', '2.5'),
      boardBookFromModel(1.7, 1.1, 'btts', null),
    ];
    const fit = boardGoalsFit(board)!;
    expect(fit.totalsLine).toBe('2.5');
    expect(fit.lambdaHome).toBeCloseTo(1.7, 1);
    expect(fit.lambdaAway).toBeCloseTo(1.1, 1);
    expect(fit.residual).toBeLessThan(0.01);
  });

  it('uses another x.5 goal line when the board has no 2.5', () => {
    const fit = boardGoalsFit([
      boardBookFromModel(1.3, 1.2, '1x2', null),
      boardBookFromModel(1.3, 1.2, 'ou', '3.5'),
    ])!;
    expect(fit.totalsLine).toBe('3.5');
    expect(fit.lambdaHome + fit.lambdaAway).toBeCloseTo(2.5, 1);
  });

  it('derives nothing without a goal line, without a 1X2, or when the two disagree', () => {
    expect(boardGoalsFit([boardBookFromModel(1.5, 1.1, '1x2', null)])).toBeNull();
    expect(boardGoalsFit([boardBookFromModel(1.5, 1.1, 'ou', '2.5')])).toBeNull();
    // A 1X2 of a very open match with an over/under of a goalless one: no model explains both.
    expect(
      boardGoalsFit([
        boardBookFromModel(3.5, 3.2, '1x2', null),
        boardBookFromModel(0.3, 0.2, 'ou', '2.5'),
      ]),
    ).toBeNull();
    expect(boardGoalsFit([])).toBeNull();
  });

  it('reads the board as one book, margin removed, and skips books it cannot use', () => {
    const consensus = boardConsensus([
      X12,
      { type: '1x2', line: null, prices: [{ code: '1', priceMilli: 1500 }] },
      boardBookFromModel(1.4, 1.2, 'ou', '2.5'),
      boardBookFromModel(1.4, 1.2, 'btts', null),
    ]);
    expect(consensus.map((c) => [c.market, c.line, c.books, c.bookmakers])).toEqual([
      ['1x2', null, 1, [BOARD_CONSENSUS_BOOKMAKER]],
      ['ou', '2.5', 1, [BOARD_CONSENSUS_BOOKMAKER]],
    ]);
    const x12 = consensus[0]!;
    const sum = Object.values(x12.probabilities).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
    expect(x12.overroundMedian).toBeGreaterThan(1);
  });

  it('never throws, and a fit it keeps always explains the board within the limit', () => {
    const price = fc.integer({ min: 1, max: 60_000 });
    fc.assert(
      fc.property(price, price, price, price, price, (h, d, a, o, u) => {
        const fit = boardGoalsFit([
          {
            type: '1x2',
            line: null,
            prices: [
              { code: '1', priceMilli: h },
              { code: 'X', priceMilli: d },
              { code: '2', priceMilli: a },
            ],
          },
          {
            type: 'ou',
            line: '2.5',
            prices: [
              { code: 'over', priceMilli: o },
              { code: 'under', priceMilli: u },
            ],
          },
        ]);
        if (fit !== null) {
          expect(fit.residual).toBeLessThanOrEqual(0.03);
          expect(fit.lambdaHome).toBeGreaterThan(0);
          expect(fit.lambdaAway).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});

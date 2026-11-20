import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BOARD_KEY_MARKER,
  bestBookPrices,
  bestPriceKey,
  capAtBestPrice,
  cappedPricingKey,
  hasBoardPrices,
  uncappedPricingKey,
  type BestBookPrices,
  type CappableMarket,
} from './best-price';
import type { MarketPriceRow } from './market-consensus';

const row = (
  bookmaker: string,
  market: '1x2' | 'ou',
  line: string | null,
  selection: string,
  priceMilli: number,
): MarketPriceRow => ({ bookmaker, market, line, selection, priceMilli });

const m = (type: string, line: string | null, prices: Record<string, number>): CappableMarket => ({
  type,
  line,
  selections: Object.entries(prices).map(([code, oddsMilli]) => ({ code, oddsMilli })),
});

describe('bestPriceKey', () => {
  it('keys the 1X2 and half-point over/under lines, nothing else', () => {
    expect(bestPriceKey('1x2', null, 'x')).toBe('1x2||X');
    expect(bestPriceKey('1x2', '2.5', '1')).toBe('1x2||1');
    expect(bestPriceKey('ou', '02.50', 'Over')).toBe('ou|2.5|over');
    expect(bestPriceKey('ou', '2', 'over')).toBeNull();
    expect(bestPriceKey('ou', '2.25', 'over')).toBeNull();
    expect(bestPriceKey('ou', null, 'over')).toBeNull();
    expect(bestPriceKey('1x2', null, 'over')).toBeNull();
    expect(bestPriceKey('ht_1x2', null, '1')).toBeNull();
    expect(bestPriceKey('ah', '-0.5', '1')).toBeNull();
  });
});

describe('bestBookPrices', () => {
  it('takes the highest price per market, line and selection', () => {
    const best = bestBookPrices([
      row('a:one', '1x2', null, '1', 2100),
      row('a:two', '1x2', null, '1', 2150),
      row('a:one', '1x2', null, 'X', 3300),
      row('a:one', 'ou', '2.5', 'over', 1900),
      row('a:two', 'ou', '2.50', 'over', 1950),
      row('a:two', 'ou', '3.5', 'over', 2900),
    ]);
    expect(best.get('1x2||1')).toEqual({ oddsMilli: 2150, bookmaker: 'a:two' });
    expect(best.get('1x2||X')).toEqual({ oddsMilli: 3300, bookmaker: 'a:one' });
    expect(best.get('ou|2.5|over')).toEqual({ oddsMilli: 1950, bookmaker: 'a:two' });
    expect(best.get('ou|3.5|over')).toEqual({ oddsMilli: 2900, bookmaker: 'a:two' });
    expect(best.size).toBe(4);
  });

  it('ignores insane prices, unknown selections and bad lines; ties go to the first name', () => {
    const best = bestBookPrices([
      row('a:z', '1x2', null, '1', 2000),
      row('a:b', '1x2', null, '1', 2000),
      row('a:c', '1x2', null, '1', 1_000_001),
      row('a:c', '1x2', null, '2', 1005),
      row('a:c', '1x2', null, '2', 2.5),
      row('a:c', '1x2', null, 'draw', 3000),
      row('a:c', 'ou', '2', 'over', 1800),
      row('  ', '1x2', null, 'X', 3000),
    ]);
    expect([...best.keys()]).toEqual(['1x2||1']);
    expect(best.get('1x2||1')).toEqual({ oddsMilli: 2000, bookmaker: 'a:b' });
  });
});

describe('capAtBestPrice', () => {
  const best: BestBookPrices = new Map([
    ['1x2||1', { oddsMilli: 2000, bookmaker: 'a:pinnacle' }],
    ['1x2||X', { oddsMilli: 3400, bookmaker: 'a:unibet' }],
    ['1x2||2', { oddsMilli: 4000, bookmaker: 'a:unibet' }],
    ['ou|2.5|over', { oddsMilli: 1900, bookmaker: 'a:pinnacle' }],
    ['ou|2.5|under', { oddsMilli: 1950, bookmaker: 'a:pinnacle' }],
  ]);
  const ours = [
    m('1x2', null, { '1': 2050, X: 3300, '2': 4000 }),
    m('ou', '2.5', { over: 1880, under: 2010 }),
    m('ou', '3.5', { over: 3000, under: 1300 }),
    m('btts', null, { yes: 1800, no: 1950 }),
    m('ht_1x2', null, { '1': 2900, X: 2100, '2': 4800 }),
  ];

  it('lists every selection above the best book price, with both prices', () => {
    const { outOfLine } = capAtBestPrice(ours, best, { cap: false });
    expect(outOfLine).toEqual([
      {
        market: '1x2',
        line: null,
        selection: '1',
        ourOddsMilli: 2050,
        bestOddsMilli: 2000,
        bestBookmaker: 'a:pinnacle',
      },
      {
        market: 'ou',
        line: '2.5',
        selection: 'under',
        ourOddsMilli: 2010,
        bestOddsMilli: 1950,
        bestBookmaker: 'a:pinnacle',
      },
    ]);
  });

  it('without the cap the prices are unchanged', () => {
    const { markets } = capAtBestPrice(ours, best, { cap: false });
    expect(markets).toEqual(ours);
  });

  it('with the cap only the out-of-line selections move, to the best book price', () => {
    const { markets, outOfLine } = capAtBestPrice(ours, best, { cap: true });
    expect(outOfLine).toHaveLength(2);
    expect(markets[0]).toEqual(m('1x2', null, { '1': 2000, X: 3300, '2': 4000 }));
    expect(markets[1]).toEqual(m('ou', '2.5', { over: 1880, under: 1950 }));
    // No book price on the line, or a market the books do not quote: the very same object.
    expect(markets[2]).toBe(ours[2]);
    expect(markets[3]).toBe(ours[3]);
    expect(markets[4]).toBe(ours[4]);
    // The input is not mutated.
    expect(ours[0]!.selections[0]!.oddsMilli).toBe(2050);
  });

  it('a price equal to the best book price is not out of line', () => {
    const { outOfLine } = capAtBestPrice([m('1x2', null, { '2': 4000 })], best, { cap: true });
    expect(outOfLine).toEqual([]);
  });

  describe('properties', () => {
    const LINES = ['1.5', '2.5', '3.5'] as const;
    const price = fc.integer({ min: 1010, max: 50_000 });
    const marketArb: fc.Arbitrary<CappableMarket> = fc.oneof(
      fc.record({ '1': price, X: price, '2': price }).map((p) => m('1x2', null, p)),
      fc
        .tuple(fc.constantFrom(...LINES), price, price)
        .map(([line, over, under]) => m('ou', line, { over, under })),
      fc.record({ yes: price, no: price }).map((p) => m('btts', null, p)),
      fc.record({ '1': price, X: price, '2': price }).map((p) => m('ht_1x2', null, p)),
    );
    const keys = [
      '1x2||1',
      '1x2||X',
      '1x2||2',
      ...LINES.flatMap((l) => [`ou|${l}|over`, `ou|${l}|under`]),
    ];
    const bestArb: fc.Arbitrary<BestBookPrices> = fc
      .subarray(keys)
      .chain((ks) =>
        fc.tuple(fc.constant(ks), fc.array(price, { minLength: ks.length, maxLength: ks.length })),
      )
      .map(
        ([ks, ps]) => new Map(ks.map((k, i) => [k, { oddsMilli: ps[i]!, bookmaker: `a:b${i}` }])),
      );
    const marketsArb = fc.array(marketArb, { maxLength: 6 });

    it('capping never raises a price and leaves nothing above the best book price', () => {
      fc.assert(
        fc.property(marketsArb, bestArb, (markets, top) => {
          const capped = capAtBestPrice(markets, top, { cap: true }).markets;
          expect(capped).toHaveLength(markets.length);
          capped.forEach((market, i) => {
            market.selections.forEach((s, j) => {
              const before = markets[i]!.selections[j]!;
              expect(s.code).toBe(before.code);
              expect(Number.isSafeInteger(s.oddsMilli)).toBe(true);
              expect(s.oddsMilli).toBeLessThanOrEqual(before.oddsMilli);
              const key = bestPriceKey(market.type, market.line, s.code);
              const b = key === null ? undefined : top.get(key);
              if (b !== undefined) expect(s.oddsMilli).toBeLessThanOrEqual(b.oddsMilli);
              else expect(s.oddsMilli).toBe(before.oddsMilli);
            });
          });
        }),
      );
    });

    it('is idempotent, and a capped book has nothing out of line', () => {
      fc.assert(
        fc.property(marketsArb, bestArb, (markets, top) => {
          const once = capAtBestPrice(markets, top, { cap: true });
          const twice = capAtBestPrice(once.markets, top, { cap: true });
          expect(twice.markets).toEqual(once.markets);
          expect(twice.outOfLine).toEqual([]);
        }),
      );
    });

    it('the out-of-line list is the same with or without the cap; without it nothing moves', () => {
      fc.assert(
        fc.property(marketsArb, bestArb, (markets, top) => {
          const off = capAtBestPrice(markets, top, { cap: false });
          const on = capAtBestPrice(markets, top, { cap: true });
          expect(off.markets).toEqual(markets);
          expect(off.outOfLine).toEqual(on.outOfLine);
          for (const o of on.outOfLine) expect(o.ourOddsMilli).toBeGreaterThan(o.bestOddsMilli);
          const changed = on.markets.flatMap((x, i) =>
            x.selections.filter((s, j) => s.oddsMilli !== markets[i]!.selections[j]!.oddsMilli),
          ).length;
          expect(changed).toBe(on.outOfLine.length);
        }),
      );
    });

    it('with no book prices everything is unchanged', () => {
      fc.assert(
        fc.property(marketsArb, (markets) => {
          const r = capAtBestPrice(markets, new Map(), { cap: true });
          expect(r.markets).toEqual(markets);
          expect(r.outOfLine).toEqual([]);
        }),
      );
    });

    it('the best price is the maximum of the sane rows', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              bookmaker: fc.constantFrom('a:x', 'a:y', 'b:z'),
              selection: fc.constantFrom('1', 'X', '2'),
              priceMilli: fc.integer({ min: 900, max: 60_000 }),
            }),
          ),
          (rows) => {
            const best = bestBookPrices(rows.map((r) => ({ ...r, market: '1x2', line: null })));
            for (const code of ['1', 'X', '2']) {
              const sane = rows
                .filter((r) => r.selection === code && r.priceMilli >= 1010)
                .map((r) => r.priceMilli);
              expect(best.get(`1x2||${code}`)?.oddsMilli).toBe(
                sane.length === 0 ? undefined : Math.max(...sane),
              );
            }
          },
        ),
      );
    });
  });
});

describe('hasBoardPrices', () => {
  it('finds the board marker before or after an O7 cap part, and nothing else', () => {
    const base = 'mkt1|1x2=2000,3400,3900';
    const board = `${base}${BOARD_KEY_MARKER}0123456789abcdef`;
    expect(hasBoardPrices(base)).toBe(false);
    expect(hasBoardPrices(board)).toBe(true);
    const capped = cappedPricingKey(board, [
      {
        market: '1x2',
        line: null,
        selection: '1',
        ourOddsMilli: 2100,
        bestOddsMilli: 2050,
        bestBookmaker: 'u:pinnacle',
      },
    ]);
    expect(hasBoardPrices(capped)).toBe(true);
    // The cap part comes off; the board part stays (it changes what the prices are).
    expect(uncappedPricingKey(capped)).toBe(board);
    expect(hasBoardPrices(null)).toBe(false);
    expect(hasBoardPrices(undefined)).toBe(false);
  });
});

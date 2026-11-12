import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FACTORY_MARKETS, LEGACY_FOOTBALL_TYPES } from './market-factory';
import {
  FACTORY_SORT_ORDER_BASE,
  factoryMarketKey,
  factoryMarketSortOrder,
  isFactoryOnlyMarketType,
  isLegacyMarketType,
  isSettleableMarket,
  resolveMarketSelection,
} from './market-resolve';
import { type MarketTypeCode, type ResolutionInput, resolveSelection } from './markets';

describe('market kinds', () => {
  it('tells today’s types from factory-only ones', () => {
    expect(isLegacyMarketType('1x2')).toBe(true);
    expect(isLegacyMarketType('ml')).toBe(true);
    expect(isLegacyMarketType('htft')).toBe(false);
    expect(isFactoryOnlyMarketType('htft')).toBe(true);
    expect(isFactoryOnlyMarketType('1x2')).toBe(false);
    expect(isFactoryOnlyMarketType('nope')).toBe(false);
    for (const type of LEGACY_FOOTBALL_TYPES) expect(isFactoryOnlyMarketType(type)).toBe(false);
  });

  it('knows which stored markets can be settled', () => {
    expect(isSettleableMarket('ou', '7.5')).toBe(true); // today's type, any valid line
    expect(isSettleableMarket('ou', '2.25')).toBe(false);
    expect(isSettleableMarket('ou', null)).toBe(false);
    expect(isSettleableMarket('multigoals', '1-3')).toBe(true);
    expect(isSettleableMarket('multigoals', '1-9')).toBe(false);
    expect(isSettleableMarket('htft', null)).toBe(true);
    expect(isSettleableMarket('nope', null)).toBe(false);
  });

  it('keys and orders factory-only markets after today’s', () => {
    expect(factoryMarketKey('multigoals', '1-3')).toBe('multigoals:1-3');
    expect(factoryMarketKey('htft')).toBe('htft');
    expect(() => factoryMarketKey('1x2')).toThrow(RangeError);
    expect(() => factoryMarketKey('htft', '2.5')).toThrow(RangeError);
    const orders = FACTORY_MARKETS.filter((m) => isFactoryOnlyMarketType(m.type)).map((m) =>
      factoryMarketSortOrder(m.type, m.line),
    );
    expect(Math.min(...orders)).toBeGreaterThanOrEqual(FACTORY_SORT_ORDER_BASE);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe('resolveMarketSelection', () => {
  const finished = fc
    .record({
      htHome: fc.integer({ min: 0, max: 4 }),
      htAway: fc.integer({ min: 0, max: 4 }),
      shHome: fc.integer({ min: 0, max: 4 }),
      shAway: fc.integer({ min: 0, max: 4 }),
    })
    .map((s): ResolutionInput => ({
      status: 'finished',
      score: {
        home: s.htHome + s.shHome,
        away: s.htAway + s.shAway,
        htHome: s.htHome,
        htAway: s.htAway,
      },
    }));

  it('settles today’s types exactly as resolveSelection', () => {
    const legacy = FACTORY_MARKETS.filter((m) => isLegacyMarketType(m.type));
    fc.assert(
      fc.property(finished, fc.constantFrom(...legacy), (input, market) => {
        for (const selection of market.selections) {
          expect(resolveMarketSelection(market, selection, input)).toBe(
            resolveSelection(
              { type: market.type as MarketTypeCode, line: market.line },
              selection,
              input,
            ),
          );
        }
      }),
      { numRuns: 500 },
    );
  });

  it('settles factory-only types: exactly the winners of the rule, or all void', () => {
    const factoryOnly = FACTORY_MARKETS.filter((m) => isFactoryOnlyMarketType(m.type));
    fc.assert(
      fc.property(finished, fc.constantFrom(...factoryOnly), (input, market) => {
        const results = market.selections.map((s) => resolveMarketSelection(market, s, input));
        const won = results.filter((r) => r === 'won').length;
        const voided = results.filter((r) => r === 'void').length;
        if (voided > 0) expect(voided).toBe(results.length);
        else expect(won).toBeLessThanOrEqual(market.winners);
      }),
      { numRuns: 1000 },
    );
  });

  it('throws for a market that is neither', () => {
    expect(() =>
      resolveMarketSelection({ type: 'nope' }, 'yes', {
        status: 'finished',
        score: { home: 1, away: 0 },
      }),
    ).toThrow(RangeError);
  });
});

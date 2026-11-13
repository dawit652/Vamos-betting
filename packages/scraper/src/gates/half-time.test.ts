import { readFileSync } from 'node:fs';
import { MARKET_TYPES, type MarketTypeCode } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sourceCapabilities } from '../adapters/capabilities';
import {
  halfTimeCoverage,
  halfTimeCovered,
  isHalfTimeMarket,
  offersHalfTimeMarkets,
  withoutHalfTimeMarkets,
  type HalfTimeSource,
} from './half-time';

const ALL_TYPES = Object.keys(MARKET_TYPES) as MarketTypeCode[];

const source = (
  caps: Partial<HalfTimeSource['capabilities']>,
  competitionIds: string[] = ['c-1'],
): HalfTimeSource => ({
  capabilities: { fullTime: true, halfTime: false, competitionPerRecord: false, ...caps },
  competitionIds,
});

describe('isHalfTimeMarket', () => {
  it('is true for ht_1x2 among today’s types, and false for unknown or inherited names', () => {
    expect(ALL_TYPES.filter(isHalfTimeMarket)).toEqual(['ht_1x2']);
    for (const name of ['', 'toString', '__proto__', 'constructor', 'HT_1X2', 'nope']) {
      expect(isHalfTimeMarket(name), name).toBe(false);
    }
  });

  it('covers the factory markets that settle on a half or on both halves (plan task 2.3)', () => {
    for (const name of ['htft', 'h2_1x2', 'h1_ou', 'home_score_both_halves', 'htcs_ft_result']) {
      expect(isHalfTimeMarket(name), name).toBe(true);
    }
    for (const name of ['multigoals', 'ft_1x2_btts', 'exact_goals', 'home_win_to_nil']) {
      expect(isHalfTimeMarket(name), name).toBe(false);
    }
  });
});

describe('withoutHalfTimeMarkets', () => {
  it('drops ht_1x2 and keeps every other market in its order', () => {
    const book = [
      { type: '1x2', line: null },
      { type: 'ht_1x2', line: null },
      { type: 'ou', line: '2.5' },
      { type: 'cs', line: null },
    ];
    expect(withoutHalfTimeMarkets(book)).toEqual([book[0], book[2], book[3]]);
    expect(withoutHalfTimeMarkets([])).toEqual([]);
  });

  it('never removes a market that is not a half-time one, and leaves no half-time market (property)', () => {
    const market = fc.record({
      type: fc.oneof(fc.constantFrom(...ALL_TYPES), fc.string()),
      line: fc.option(fc.constantFrom('1.5', '2.5', '-0.5'), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(market, { maxLength: 30 }), (book) => {
        const kept = withoutHalfTimeMarkets(book);
        // Exactly the non-half-time markets, same objects, same order.
        expect(kept).toEqual(book.filter((m) => m.type !== 'ht_1x2'));
        expect(kept.every((m) => !isHalfTimeMarket(m.type))).toBe(true);
        for (const m of book) if (!isHalfTimeMarket(m.type)) expect(kept).toContain(m);
        // Idempotent.
        expect(withoutHalfTimeMarkets(kept)).toEqual(kept);
      }),
    );
  });
});

describe('halfTimeCoverage', () => {
  it('counts a competition only where a source gives full time with half time', () => {
    const coverage = halfTimeCoverage([
      source({ halfTime: false }, ['ft-only']),
      source({ halfTime: true }, ['both', 'second']),
      // A half time without a full-time score is not a result source (fixtures-only configs).
      source({ fullTime: false, halfTime: true }, ['no-ft']),
    ]);
    expect(coverage.everywhere).toBe(false);
    expect([...coverage.competitions].sort()).toEqual(['both', 'second']);
    expect(halfTimeCovered(coverage, 'both')).toBe(true);
    expect(halfTimeCovered(coverage, 'ft-only')).toBe(false);
    expect(halfTimeCovered(coverage, 'no-ft')).toBe(false);
    expect(halfTimeCovered(coverage, 'unknown')).toBe(false);
  });

  it('no source covers nothing', () => {
    const coverage = halfTimeCoverage([]);
    expect(halfTimeCovered(coverage, 'c-1')).toBe(false);
  });

  it('a half-time source whose competition comes per record covers every competition', () => {
    const coverage = halfTimeCoverage([source({ halfTime: true, competitionPerRecord: true }, [])]);
    expect(coverage.everywhere).toBe(true);
    expect(halfTimeCovered(coverage, 'anything')).toBe(true);
    // A per-record source without half time covers nothing.
    expect(
      halfTimeCovered(halfTimeCoverage([source({ competitionPerRecord: true }, [])]), 'x'),
    ).toBe(false);
  });

  it('follows sourceCapabilities of the shipped source files', () => {
    const fromFile = (name: string): HalfTimeSource => {
      const row = JSON.parse(
        readFileSync(
          new URL(`../../../../docs/scraper-plan/data/${name}`, import.meta.url),
          'utf8',
        ),
      ) as Parameters<typeof sourceCapabilities>[0];
      const result = sourceCapabilities(row);
      if (!result.ok) throw new Error(result.errors.join());
      return { capabilities: result.capabilities, competitionIds: ['epl'] };
    };
    // The Odds API's scores give no half time; football-data.org and openfootball do.
    const scores = fromFile('source-theoddsapi-scores-en1.json');
    expect(halfTimeCovered(halfTimeCoverage([scores]), 'epl')).toBe(false);
    for (const name of ['source-footballdata-en1.json', 'source-openfootball-en1.json']) {
      expect(halfTimeCovered(halfTimeCoverage([scores, fromFile(name)]), 'epl'), name).toBe(true);
    }
  });
});

describe('offersHalfTimeMarkets', () => {
  it('`all` always offers; `covered` offers where covered or where the event already has one', () => {
    const bools = fc.boolean();
    fc.assert(
      fc.property(bools, bools, (covered, eventHasHalfTimeMarket) => {
        expect(offersHalfTimeMarkets({ setting: 'all', covered, eventHasHalfTimeMarket })).toBe(
          true,
        );
        expect(offersHalfTimeMarkets({ setting: 'covered', covered, eventHasHalfTimeMarket })).toBe(
          covered || eventHasHalfTimeMarket,
        );
      }),
    );
  });
});

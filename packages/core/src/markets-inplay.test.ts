import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CORRECT_SCORE_SELECTIONS,
  type FinalScore,
  type InPlayScore,
  MARKET_TYPES,
  type MarketTypeCode,
  type SelectionResult,
  certainMarketResult,
  resolveSelection,
  selectionsFor,
} from './markets';

const ALL_TYPES = Object.keys(MARKET_TYPES) as MarketTypeCode[];
/** Markets that are only ever decided at full time. */
const FULL_TIME_ONLY: readonly MarketTypeCode[] = ['1x2', 'dc', 'dnb', 'ml', 'winner'];

type MarketRef = { type: MarketTypeCode; line: string | null };

const score = (home: number, away: number, ht?: [number, number]): InPlayScore =>
  ht === undefined ? { home, away } : { home, away, htHome: ht[0], htAway: ht[1] };

/** Every selection resolved against a finished score. */
function resolvedAt(market: MarketRef, final: FinalScore): Record<string, SelectionResult> {
  return Object.fromEntries(
    selectionsFor(market.type).map((selection) => [
      selection,
      resolveSelection(market, selection, { status: 'finished', score: final }),
    ]),
  );
}

/** A result in which `winner` won and every other selection of the market lost. */
function onlyWinner(type: MarketTypeCode, winner: string): Record<string, SelectionResult> {
  return Object.fromEntries(selectionsFor(type).map((s) => [s, s === winner ? 'won' : 'lost']));
}

describe('certainMarketResult – decided markets', () => {
  it('over/under: over has won once the goals are above the line', () => {
    const ou = { type: 'ou' as const, line: '2.5' };
    expect(certainMarketResult(ou, score(2, 1))).toEqual({ over: 'won', under: 'lost' });
    expect(certainMarketResult(ou, score(3, 0))).toEqual({ over: 'won', under: 'lost' });
    expect(certainMarketResult({ type: 'ou', line: '0.5' }, score(0, 1))).toEqual({
      over: 'won',
      under: 'lost',
    });
  });

  it('over/under: not decided while the line can still be passed (under only at full time)', () => {
    const ou = { type: 'ou' as const, line: '2.5' };
    for (const [home, away] of [
      [0, 0],
      [1, 1],
      [2, 0],
      [0, 2],
    ] as const) {
      expect(certainMarketResult(ou, score(home, away))).toBeNull();
    }
    expect(certainMarketResult({ type: 'ou', line: '4.5' }, score(2, 2, [1, 1]))).toBeNull();
  });

  it('basketball total: over has won once the points are above the line', () => {
    const total = { type: 'total' as const, line: '215.5' };
    expect(certainMarketResult(total, score(110, 106))).toEqual({ over: 'won', under: 'lost' });
    expect(certainMarketResult(total, score(110, 105))).toBeNull();
    // The line is canonicalised like everywhere else ("02.5" is 2.5).
    expect(certainMarketResult({ type: 'ou', line: '02.5' }, score(2, 1))).toEqual({
      over: 'won',
      under: 'lost',
    });
  });

  it('both teams to score: yes has won once both teams scored; no is never decided early', () => {
    const btts = { type: 'btts' as const, line: null };
    expect(certainMarketResult(btts, score(1, 1))).toEqual({ yes: 'won', no: 'lost' });
    expect(certainMarketResult(btts, score(3, 2))).toEqual({ yes: 'won', no: 'lost' });
    expect(certainMarketResult(btts, score(0, 0))).toBeNull();
    expect(certainMarketResult(btts, score(4, 0))).toBeNull();
    expect(certainMarketResult(btts, score(0, 3, [0, 2]))).toBeNull();
  });

  it('correct score: "other" has won once a team has more than 4 goals', () => {
    const cs = { type: 'cs' as const, line: null };
    expect(certainMarketResult(cs, score(5, 0))).toEqual(onlyWinner('cs', 'other'));
    expect(certainMarketResult(cs, score(2, 7))).toEqual(onlyWinner('cs', 'other'));
    expect(Object.keys(certainMarketResult(cs, score(5, 0)) ?? {})).toEqual([
      ...CORRECT_SCORE_SELECTIONS,
    ]);
    expect(certainMarketResult(cs, score(4, 4))).toBeNull();
    expect(certainMarketResult(cs, score(0, 0))).toBeNull();
  });

  it('half-time result: decided by the half-time score once the first half is over', () => {
    const ht = { type: 'ht_1x2' as const, line: null };
    expect(certainMarketResult(ht, score(1, 0))).toBeNull();
    expect(certainMarketResult(ht, score(1, 2, [1, 0]))).toEqual({
      '1': 'won',
      X: 'lost',
      '2': 'lost',
    });
    expect(certainMarketResult(ht, score(0, 0, [0, 0]))).toEqual({
      '1': 'lost',
      X: 'won',
      '2': 'lost',
    });
    expect(certainMarketResult(ht, score(3, 3, [0, 2]))).toEqual({
      '1': 'lost',
      X: 'lost',
      '2': 'won',
    });
  });

  it('match result, double chance, draw no bet and winners are only decided at full time', () => {
    for (const type of FULL_TIME_ONLY) {
      for (const s of [score(0, 0), score(9, 0), score(0, 9, [0, 5]), score(3, 2)]) {
        expect(certainMarketResult({ type, line: null }, s)).toBeNull();
      }
    }
  });

  it('returns a frozen result', () => {
    const result = certainMarketResult({ type: 'btts', line: null }, score(1, 1));
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('certainMarketResult – input validation', () => {
  it('rejects a bad market or line', () => {
    expect(() => certainMarketResult({ type: 'ou', line: null }, score(3, 0))).toThrow(RangeError);
    expect(() => certainMarketResult({ type: 'ou', line: '2' }, score(3, 0))).toThrow(RangeError);
    expect(() => certainMarketResult({ type: 'btts', line: '2.5' }, score(1, 1))).toThrow(
      RangeError,
    );
    expect(() =>
      certainMarketResult({ type: 'nope' as MarketTypeCode, line: null }, score(1, 1)),
    ).toThrow(RangeError);
  });

  it('rejects a bad score', () => {
    const btts = { type: 'btts' as const, line: null };
    for (const bad of [
      { home: -1, away: 0 },
      { home: 1.5, away: 0 },
      { home: Number.NaN, away: 0 },
      { home: 1, away: 1, htHome: 1, htAway: null },
      { home: 1, away: 1, htHome: null, htAway: 0 },
      { home: 1, away: 1, htHome: 2, htAway: 0 },
      { home: 1, away: 1, htHome: 0, htAway: -1 },
    ]) {
      expect(() => certainMarketResult(btts, bad)).toThrow(RangeError);
    }
    expect(() => certainMarketResult(btts, null as unknown as InPlayScore)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

/** Points per side are small in football, tennis and volleyball, large in basketball. */
const maxPointsOf = (type: MarketTypeCode): number =>
  MARKET_TYPES[type].sport === 'basketball' ? 300 : 10;

const marketArb: fc.Arbitrary<MarketRef> = fc
  .constantFrom(...ALL_TYPES)
  .chain((type): fc.Arbitrary<MarketRef> => {
    if (type === 'ou')
      return fc.integer({ min: 0, max: 12 }).map((n) => ({ type, line: `${n}.5` }));
    if (type === 'total') {
      return fc.integer({ min: 0, max: 400 }).map((n) => ({ type, line: `${n}.5` }));
    }
    return fc.constant({ type, line: null });
  });

interface InPlayCase {
  market: MarketRef;
  now: InPlayScore & { htHome: number | null; htAway: number | null };
  /** A final score the match can still end on from `now`. */
  final: FinalScore;
}

/**
 * A market, an in-play score (with or without the half-time score) and a final
 * score reachable from it: each side ends with at least its current score, and
 * the half-time score is the one given, or (first half still running) lies
 * between the current and the final score.
 */
const inPlayCaseArb: fc.Arbitrary<InPlayCase> = marketArb.chain((market) => {
  const max = maxPointsOf(market.type);
  const points = fc.integer({ min: 0, max });
  return fc
    .record({
      home: points,
      away: points,
      firstHalfOver: fc.boolean(),
      htShare: fc.tuple(fc.nat(max), fc.nat(max)),
      extraHome: points,
      extraAway: points,
      extraHtHome: fc.nat(max),
      extraHtAway: fc.nat(max),
    })
    .map((r): InPlayCase => {
      const ht = r.firstHalfOver
        ? { htHome: r.htShare[0] % (r.home + 1), htAway: r.htShare[1] % (r.away + 1) }
        : { htHome: null, htAway: null };
      const finalHome = r.home + r.extraHome;
      const finalAway = r.away + r.extraAway;
      const finalHt =
        ht.htHome !== null && ht.htAway !== null
          ? { htHome: ht.htHome, htAway: ht.htAway }
          : {
              htHome: r.home + (r.extraHtHome % (r.extraHome + 1)),
              htAway: r.away + (r.extraHtAway % (r.extraAway + 1)),
            };
      return {
        market,
        now: { home: r.home, away: r.away, ...ht },
        final: { home: finalHome, away: finalAway, ...finalHt },
      };
    });
});

describe('certainMarketResult – properties', () => {
  it('never decides a market whose outcome can still change: every reachable final agrees', () => {
    fc.assert(
      fc.property(inPlayCaseArb, ({ market, now, final }) => {
        const decided = certainMarketResult(market, now);
        if (decided === null) return;
        expect(decided).toEqual(resolvedAt(market, final));
      }),
      { numRuns: 2_000 },
    );
  });

  it('a decided market has exactly one winning selection and no void', () => {
    fc.assert(
      fc.property(inPlayCaseArb, ({ market, now }) => {
        const decided = certainMarketResult(market, now);
        if (decided === null) return;
        const results = Object.values(decided);
        expect(results.filter((r) => r === 'won')).toHaveLength(1);
        expect(results).not.toContain('void');
        expect(Object.keys(decided).sort()).toEqual([...selectionsFor(market.type)].sort());
      }),
    );
  });

  it('decides as soon as the outcome is certain (two reachable finals differ otherwise)', () => {
    fc.assert(
      fc.property(inPlayCaseArb, ({ market, now }) => {
        fc.pre(!FULL_TIME_ONLY.includes(market.type));
        const decided = certainMarketResult(market, now);
        fc.pre(decided === null);
        // No more goals at all...
        const ht =
          now.htHome !== null && now.htAway !== null
            ? { htHome: now.htHome, htAway: now.htAway }
            : { htHome: now.home, htAway: now.away };
        const quiet: FinalScore = { home: now.home, away: now.away, ...ht };
        // ...against a finish that turns the market: enough goals for both
        // sides to pass any line, both teams to score, leave the correct-score
        // grid, and (first half still running) change the half-time result.
        const swing = market.type === 'total' ? 1_000 : 20;
        const lively: FinalScore = {
          home: now.home + swing,
          away: now.away + swing,
          ...(now.htHome !== null && now.htAway !== null
            ? { htHome: now.htHome, htAway: now.htAway }
            : now.home > now.away
              ? { htHome: now.home, htAway: now.home + 1 }
              : { htHome: now.away + 1, htAway: now.away }),
        };
        expect(resolvedAt(market, lively)).not.toEqual(resolvedAt(market, quiet));
      }),
      { numRuns: 1_000 },
    );
  });

  it('match result, double chance, draw no bet and winners are never decided in play', () => {
    fc.assert(
      fc.property(inPlayCaseArb, ({ market, now }) => {
        fc.pre(FULL_TIME_ONLY.includes(market.type));
        expect(certainMarketResult(market, now)).toBeNull();
      }),
    );
  });
});

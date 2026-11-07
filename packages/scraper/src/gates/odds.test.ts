import { CORRECT_SCORE_SELECTIONS, MAX_ODDS_MILLI, MIN_ODDS_MILLI } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MIN_RATING_MATCHES } from '../constants';
import {
  checkMarkets,
  checkReprice,
  type GateMarket,
  isCalibrated,
  type OddsCheck,
  PRICE_MOVE_LIMITED_MARKETS,
  ratingsKey,
  repriceReview,
} from './odds';

const codes = (check: OddsCheck): string[] => (check.ok ? [] : check.issues.map((i) => i.code));
const m1x2 = (home: number, draw: number, away: number): GateMarket => ({
  type: '1x2',
  line: null,
  selections: [
    { code: '1', oddsMilli: home },
    { code: 'X', oddsMilli: draw },
    { code: '2', oddsMilli: away },
  ],
});
const twoWay = (
  type: 'btts' | 'ou',
  a: number,
  b: number,
  line: string | null = null,
): GateMarket => ({
  type,
  line,
  selections:
    type === 'btts'
      ? [
          { code: 'yes', oddsMilli: a },
          { code: 'no', oddsMilli: b },
        ]
      : [
          { code: 'over', oddsMilli: a },
          { code: 'under', oddsMilli: b },
        ],
});

describe('O1 calibrated teams', () => {
  it('needs MIN_RATING_MATCHES matches or manual = 1', () => {
    expect(isCalibrated({ matches: MIN_RATING_MATCHES - 1 })).toBe(false);
    expect(isCalibrated({ matches: MIN_RATING_MATCHES })).toBe(true);
    expect(isCalibrated({ matches: 0, manual: 1 })).toBe(true);
    for (const ratings of [
      null,
      undefined,
      {},
      { manual: 2 },
      { manual: '1' },
      { matches: 8.5 },
      { matches: '9' },
    ]) {
      expect(isCalibrated(ratings as Record<string, unknown> | null | undefined)).toBe(false);
    }
  });

  it('a configured minimum may raise the floor, never lower it', () => {
    expect(isCalibrated({ matches: MIN_RATING_MATCHES - 1 }, 3)).toBe(false);
    expect(isCalibrated({ matches: 10 }, 11)).toBe(false);
    expect(isCalibrated({ matches: 11 }, 11)).toBe(true);
    expect(() => isCalibrated({ matches: 9 }, -1)).toThrow(RangeError);
    expect(() => isCalibrated({ matches: 9 }, 1.5)).toThrow(RangeError);
  });
});

describe('O2 sane prices', () => {
  it('accepts a normal book and checks bounds exactly', () => {
    expect(checkMarkets([m1x2(2100, 3300, 3500)])).toEqual({ ok: true });
    // 0.8 + 0.5 = 1.3 exactly: on the bound passes, a hair above fails.
    expect(checkMarkets([twoWay('btts', 1250, 2000)])).toEqual({ ok: true });
    expect(codes(checkMarkets([twoWay('btts', 1250, 1999)]))).toEqual(['overround_high']);
    // 0.5 + 0.5 + 0.01 = 1.01 exactly.
    expect(checkMarkets([m1x2(2000, 2000, 100_000)])).toEqual({ ok: true });
    expect(codes(checkMarkets([m1x2(2000, 2000, 100_001)]))).toEqual(['overround_low']);
  });

  it('a book under 1 (a sure win for the bettor) fails, in every market type', () => {
    expect(codes(checkMarkets([m1x2(3000, 3000, 3000)]))).toEqual(['overround_low']);
    const dc = (x: number): GateMarket => ({
      type: 'dc',
      line: null,
      selections: [
        { code: '1X', oddsMilli: x },
        { code: '12', oddsMilli: x },
        { code: 'X2', oddsMilli: x },
      ],
    });
    // dc covers each outcome twice: Σ/2 is its overround.
    expect(checkMarkets([dc(1400)])).toEqual({ ok: true });
    expect(codes(checkMarkets([dc(1600)]))).toEqual(['overround_low']);
    const cs = (other: number, rest: number): GateMarket => ({
      type: 'cs',
      line: null,
      selections: CORRECT_SCORE_SELECTIONS.map((code) => ({
        code,
        oddsMilli: code === 'other' ? other : rest,
      })),
    });
    expect(checkMarkets([cs(4000, 25_000)])).toEqual({ ok: true });
    expect(codes(checkMarkets([cs(30_000, 30_000)]))).toEqual(['overround_low']);
  });

  it('every price must be valid odds', () => {
    for (const bad of [MIN_ODDS_MILLI - 1, MAX_ODDS_MILLI + 1, 1850.5, Number.NaN]) {
      expect(codes(checkMarkets([m1x2(bad, 3300, 3500)]))).toEqual(['invalid_price']);
    }
  });

  it('malformed books fail closed', () => {
    const missing: GateMarket = {
      ...m1x2(2100, 3300, 3500),
      selections: m1x2(2100, 3300, 3500).selections.slice(0, 2),
    };
    expect(codes(checkMarkets([missing]))).toEqual(['bad_selections']);
    const duplicated: GateMarket = {
      ...missing,
      selections: [...missing.selections, { code: '1', oddsMilli: 2100 }],
    };
    expect(codes(checkMarkets([duplicated]))).toEqual(['bad_selections']);
    expect(codes(checkMarkets([twoWay('ou', 1900, 1900)]))).toEqual(['bad_line']);
    expect(codes(checkMarkets([twoWay('ou', 1900, 1900, '2')]))).toEqual(['bad_line']);
    expect(checkMarkets([twoWay('ou', 1800, 1800, '2.5')])).toEqual({ ok: true });
    expect(codes(checkMarkets([{ type: 'xx' as '1x2', line: null, selections: [] }]))).toEqual([
      'unknown_market',
    ]);
    expect(codes(checkMarkets([m1x2(2100, 3300, 3500), m1x2(2100, 3300, 3500)]))).toEqual([
      'duplicate_market',
    ]);
    expect(codes(checkMarkets([]))).toEqual(['no_markets']);
  });

  it('property: a 1x2 book passes exactly when 1.01 <= Σ 1/odds <= 1.3', () => {
    const odds = fc.integer({ min: MIN_ODDS_MILLI, max: 20_000 });
    fc.assert(
      fc.property(odds, odds, odds, (a, b, c) => {
        // Σ 1000/x = 1000(bc + ac + ab) / abc, compared with 101/100 and 13/10 by hand.
        const n = 1000n * (BigInt(b) * BigInt(c) + BigInt(a) * BigInt(c) + BigInt(a) * BigInt(b));
        const d = BigInt(a) * BigInt(b) * BigInt(c);
        const sane = 100n * n >= 101n * d && 10n * n <= 13n * d;
        expect(checkMarkets([m1x2(a, b, c)]).ok).toBe(sane);
      }),
    );
  });
});

describe('O3 re-pricing', () => {
  const book = (home: number) => [m1x2(home, 3200, 4000)];
  const moved = (from: number, to: number) =>
    codes(checkReprice(book(from), book(to))).includes('price_move_too_large');

  it('a move of exactly MAX_PRICE_MOVE_RATIO either way passes, one milli more does not', () => {
    expect(moved(2000, 2500)).toBe(false);
    expect(moved(2000, 2501)).toBe(true);
    expect(moved(2000, 1600)).toBe(false);
    expect(moved(2000, 1599)).toBe(true);
    expect(checkReprice(book(2000), book(2000))).toEqual({ ok: true });
  });

  describe('F-09: only the 1X2 and the 2.5 line are held to the move limit', () => {
    /** The partner price that gives a two-way book an overround of about 1.06. */
    const partner = (over: number): number => Math.floor(1000 / (1.06 - 1000 / over));
    /** An over/under book on `line` with the given over price and a balanced under. */
    const ouBook = (line: string, over: number): GateMarket =>
      twoWay('ou', over, partner(over), line);
    const main = m1x2(2000, 3200, 4000);
    const heldBy = (prev: GateMarket[], next: GateMarket[]): string[] =>
      codes(checkReprice(prev, next));

    it('names the limited markets', () => {
      expect([...PRICE_MOVE_LIMITED_MARKETS].sort()).toEqual(['1x2', 'ou:2.5']);
    });

    it('a move of the 2.5 line beyond the ratio is held, as the 1X2 is', () => {
      expect(heldBy([main, ouBook('2.5', 1900)], [main, ouBook('2.5', 2500)])).toEqual([
        'price_move_too_large',
      ]);
      expect(heldBy([main, ouBook('2.5', 1900)], [main, ouBook('2.5', 2000)])).toEqual([]);
    });

    it('a move of any other market beyond the ratio does not hold the event', () => {
      // Over 1.5 1.30 -> 2.00 (1.54x), over 3.5 1.5 -> 9.0 (6x), a both-teams-to-score tail.
      expect(heldBy([main, ouBook('1.5', 1300)], [main, ouBook('1.5', 2000)])).toEqual([]);
      expect(heldBy([main, ouBook('3.5', 1500)], [main, ouBook('3.5', 9000)])).toEqual([]);
      const btts = (yes: number): GateMarket => twoWay('btts', yes, partner(yes));
      expect(heldBy([main, btts(1800)], [main, btts(3000)])).toEqual([]);
    });

    it('the 1X2 still holds the event whatever the other markets do', () => {
      const moved = m1x2(2600, 2900, 3200); // home 2.00 -> 2.60 (1.3x), overround 1.04
      expect(heldBy([main, ouBook('1.5', 1300)], [moved, ouBook('1.5', 1310)])).toEqual([
        'price_move_too_large',
      ]);
    });

    it('O2 still applies to every market, moved or not', () => {
      // A sure win on the 1.5 line (overround below 1.01) is refused, not waved through.
      expect(heldBy([main, ouBook('1.5', 1300)], [main, twoWay('ou', 2500, 2500, '1.5')])).toEqual([
        'overround_low',
      ]);
      expect(heldBy([main, ouBook('1.5', 1300)], [main, twoWay('ou', 1050, 1050, '1.5')])).toEqual([
        'overround_high',
      ]);
      expect(heldBy([main, ouBook('1.5', 1300)], [main, twoWay('ou', 10, 1900, '1.5')])).toEqual(
        expect.arrayContaining(['invalid_price']),
      );
    });

    it('no market may be removed and every selection set must still match; a market may be added', () => {
      expect(heldBy([main, ouBook('1.5', 1300)], [main])).toEqual(['market_set_changed']);
      expect(heldBy([main], [main, ouBook('1.5', 1300)])).toEqual([]);
      const renamed: GateMarket = {
        type: 'ou',
        line: '1.5',
        selections: [
          { code: 'over', oddsMilli: 1300 },
          { code: 'below', oddsMilli: partner(1300) },
        ],
      };
      expect(heldBy([main, ouBook('1.5', 1300)], [main, renamed])).toEqual(
        expect.arrayContaining(['bad_selections', 'selection_set_changed']),
      );
    });

    it('a move of exactly the ratio passes and one milli more is held, on the limited markets', () => {
      // Same price on the under side in both books: only the over moves.
      const fixed = (over: number): GateMarket => twoWay('ou', over, 1500, '2.5');
      expect(heldBy([main, fixed(1800)], [main, fixed(2250)])).toEqual([]);
      expect(heldBy([main, fixed(1800)], [main, fixed(2251)])).toEqual(['price_move_too_large']);
    });

    it('property: another market is never held for the size of a move alone', () => {
      const odds = fc.integer({ min: 1300, max: 9000 });
      fc.assert(
        fc.property(odds, odds, (from, to) => {
          const check = checkReprice([main, ouBook('1.5', from)], [main, ouBook('1.5', to)]);
          expect(codes(check)).not.toContain('price_move_too_large');
        }),
      );
    });
  });

  it('no market may be removed, selections must match, an added market passes, and the new book must pass O2', () => {
    expect(codes(checkReprice(book(2000), [...book(2000), twoWay('btts', 1800, 1800)]))).toEqual(
      [],
    );
    // An added market is still checked by O2.
    expect(codes(checkReprice(book(2000), [...book(2000), twoWay('btts', 3000, 3000)]))).toContain(
      'overround_low',
    );
    expect(codes(checkReprice([...book(2000), twoWay('btts', 1800, 1800)], book(2000)))).toEqual([
      'market_set_changed',
    ]);
    expect(codes(checkReprice(book(2000), [m1x2(3000, 3000, 3000)]))).toContain('overround_low');
    const renamed: GateMarket = {
      ...m1x2(2000, 3200, 4000),
      selections: [
        { code: '1', oddsMilli: 2000 },
        { code: 'X', oddsMilli: 3200 },
        { code: 'Z', oddsMilli: 4000 },
      ],
    };
    expect(codes(checkReprice(book(2000), [renamed]))).toEqual(
      expect.arrayContaining(['bad_selections', 'selection_set_changed']),
    );
  });

  it('a refused re-price opens odds_approval with the proposal, apart from the F7 item', () => {
    const check = checkReprice(book(2000), book(3000));
    if (check.ok) throw new Error('expected refusal');
    const review = repriceReview({ eventId: 'ev-1', feedRef: 'fx|a' }, book(3000), check);
    expect(review).toMatchObject({ kind: 'odds_approval', subjectKey: 'fx|a|reprice' });
    expect(review.payload.proposal).toEqual([
      { type: '1x2', line: null, selections: book(3000)[0]?.selections },
    ]);
  });

  it('the proposal item carries the runner extras, but the gate fields win', () => {
    const check = checkReprice(book(2000), book(3000));
    if (check.ok) throw new Error('expected refusal');
    const review = repriceReview({ eventId: 'ev-1', feedRef: 'fx|a' }, book(3000), check, {
      ratingsKey: 'k',
      eventId: 'forged',
    });
    expect(review.payload).toMatchObject({ ratingsKey: 'k', eventId: 'ev-1' });
  });

  it('ratingsKey: equal for equal ratings whatever the key order, different when a number moves', () => {
    const a = { attack: 1.2, defence: 0.9, matches: 10 };
    expect(ratingsKey(a, a)).toBe(ratingsKey({ matches: 10, defence: 0.9, attack: 1.2 }, a));
    expect(ratingsKey(a, a)).not.toBe(ratingsKey({ ...a, matches: 11 }, a));
    expect(ratingsKey(a, a)).not.toBe(ratingsKey(a, { ...a, attack: 1.21 }));
    // The two teams are not interchangeable (home advantage).
    expect(ratingsKey(a, { ...a, attack: 1 })).not.toBe(ratingsKey({ ...a, attack: 1 }, a));
    expect(ratingsKey(null, undefined)).toBe(ratingsKey({}, {}));
    expect(ratingsKey({ attack: Number.NaN, note: 'x' }, null)).toBe(ratingsKey({}, {}));
  });

  it('property: a selection is refused exactly when next/prev leaves [0.8, 1.25]', () => {
    const odds = fc.integer({ min: MIN_ODDS_MILLI, max: 10_000 });
    fc.assert(
      fc.property(odds, odds, (from, to) => {
        expect(moved(from, to)).toBe(to * 4 > from * 5 || to * 5 < from * 4);
      }),
    );
  });
});

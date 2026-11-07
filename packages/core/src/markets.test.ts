import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CORRECT_SCORE_SELECTIONS,
  type FinalScore,
  MARKET_TYPES,
  type MarketTypeCode,
  type ResolutionInput,
  SPORT_MARKETS,
  type SelectionResult,
  type SportCode,
  MAX_HANDICAP,
  certainMarketResult,
  formatHandicap,
  marketKey,
  parseHandicap,
  parseLine,
  resolveSelection,
  selectionLabel,
  selectionsFor,
} from './markets';

const ALL_TYPES = Object.keys(MARKET_TYPES) as MarketTypeCode[];
const LINE_TYPES = ALL_TYPES.filter((type) => MARKET_TYPES[type].hasLine);
const NON_LINE_TYPES = ALL_TYPES.filter((type) => !MARKET_TYPES[type].hasLine);
/** Markets with a half-point total line (the handicaps take other lines). */
const TOTAL_TYPES = ['ou', 'total'] as const;
/** A valid line of each kind, for tests that need any one. */
const sampleLine = (type: MarketTypeCode): string | null => {
  if (type === 'ah') return '-1.5';
  if (type === 'eh') return '-1';
  return MARKET_TYPES[type].hasLine ? '2.5' : null;
};
const VOID_STATUSES = ['cancelled', 'abandoned', 'postponed'] as const;
const TEAMS = { home: 'Saint George', away: 'Fasil Kenema' };

const finished = (home: number, away: number, ht?: [number, number]): ResolutionInput => ({
  status: 'finished',
  score: ht ? { home, away, htHome: ht[0], htAway: ht[1] } : { home, away },
});

const resolve = (
  type: MarketTypeCode,
  selection: string,
  input: ResolutionInput,
  line?: string | null,
): SelectionResult => resolveSelection({ type, line }, selection, input);

/** Results of every selection of a market, keyed by selection. */
const resolveAll = (
  type: MarketTypeCode,
  input: ResolutionInput,
  line?: string | null,
): Record<string, SelectionResult> =>
  Object.fromEntries(selectionsFor(type).map((s) => [s, resolve(type, s, input, line)]));

const goalsArb = fc.integer({ min: 0, max: 12 });
const pointsArb = fc.integer({ min: 0, max: 400 });
const lineArb = fc.integer({ min: 0, max: 999 }).map((n) => `${n}.5`);
/** Asian handicap lines: half and whole steps from -6 to +6 (canonical text). */
const ahLineArb = fc.integer({ min: -12, max: 12 }).map((n) => String(n / 2));
/** Three-way handicap lines: non-zero whole numbers from -4 to +4. */
const ehLineArb = fc
  .integer({ min: 1, max: 4 })
  .chain((n) => fc.constantFrom(n, -n))
  .map(String);
const lineArbFor = (type: MarketTypeCode): fc.Arbitrary<string> => {
  if (type === 'ah') return ahLineArb;
  if (type === 'eh') return ehLineArb;
  return lineArb;
};
/** A consistent football score with half-time goals never above full time. */
const scoreWithHtArb = fc
  .tuple(goalsArb, goalsArb, goalsArb, goalsArb)
  .map(([htHome, htAway, secondHome, secondAway]): FinalScore => ({
    home: htHome + secondHome,
    away: htAway + secondAway,
    htHome,
    htAway,
  }));
type MarketRef = { type: MarketTypeCode; line: string | null };
const marketArb: fc.Arbitrary<MarketRef> = fc
  .constantFrom(...ALL_TYPES)
  .chain((type): fc.Arbitrary<MarketRef> =>
    MARKET_TYPES[type].hasLine
      ? lineArbFor(type).map((line) => ({ type, line }))
      : fc.constant({ type, line: null }),
  );

describe('MARKET_TYPES', () => {
  it('covers every market code with a matching definition', () => {
    expect([...ALL_TYPES].sort()).toEqual(
      [
        '1x2',
        'ah',
        'btts',
        'cs',
        'dc',
        'dnb',
        'eh',
        'ht_1x2',
        'ml',
        'ou',
        'total',
        'winner',
      ].sort(),
    );
    for (const type of ALL_TYPES) {
      const definition = MARKET_TYPES[type];
      expect(definition.code).toBe(type);
      expect(definition.name.en.length).toBeGreaterThan(0);
      expect(definition.name.am.length).toBeGreaterThan(0);
      expect(Number.isInteger(definition.sortOrder)).toBe(true);
    }
  });

  it('has the expected names, sports and flags', () => {
    expect(MARKET_TYPES['1x2']).toEqual({
      code: '1x2',
      sport: 'football',
      name: { en: 'Match Result', am: 'የጨዋታ ውጤት' },
      hasLine: false,
      period: 'full_time',
      sortOrder: expect.any(Number),
    });
    expect(MARKET_TYPES.dc.name).toEqual({ en: 'Double Chance', am: 'ድርብ ዕድል' });
    expect(MARKET_TYPES.ou.name).toEqual({
      en: 'Total Goals Over/Under',
      am: 'ጠቅላላ ጎል ከ በላይ/በታች',
    });
    expect(MARKET_TYPES.btts.name).toEqual({ en: 'Both Teams To Score', am: 'ሁለቱም ቡድኖች ያገባሉ' });
    expect(MARKET_TYPES.dnb.name).toEqual({ en: 'Draw No Bet', am: 'አቻ ከሆነ ገንዘብ ይመለሳል' });
    expect(MARKET_TYPES.ht_1x2.name).toEqual({
      en: 'Half-time Result',
      am: 'የመጀመሪያ አጋማሽ ውጤት',
    });
    expect(MARKET_TYPES.cs.name).toEqual({ en: 'Correct Score', am: 'ትክክለኛ ውጤት' });
    expect(MARKET_TYPES.ah.name.en).toBe('Asian Handicap');
    expect(MARKET_TYPES.eh.name.en).toBe('3-Way Handicap');
    expect(MARKET_TYPES.ml.name.am).toBe('አሸናፊ (ተጨማሪ ሰዓትን ጨምሮ)');
    expect(MARKET_TYPES.ml.name.en).toMatch(/overtime/i);
    expect(MARKET_TYPES.total.name).toEqual({
      en: 'Total Points Over/Under',
      am: 'ጠቅላላ ነጥብ ከ በላይ/በታች',
    });
    expect(MARKET_TYPES.winner.name).toEqual({ en: 'Match Winner', am: 'የጨዋታ አሸናፊ' });

    expect(MARKET_TYPES.ml.sport).toBe('basketball');
    expect(MARKET_TYPES.total.sport).toBe('basketball');
    expect(MARKET_TYPES.winner.sport).toBe('tennis');
  });

  it('only over/under and handicap markets take a line and only ht_1x2 is a half-time market', () => {
    expect([...LINE_TYPES].sort()).toEqual(['ah', 'eh', 'ou', 'total']);
    const halfTime = ALL_TYPES.filter((type) => MARKET_TYPES[type].period === 'half_time');
    expect(halfTime).toEqual(['ht_1x2']);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MARKET_TYPES)).toBe(true);
    expect(Object.isFrozen(MARKET_TYPES['1x2'])).toBe(true);
    expect(Object.isFrozen(MARKET_TYPES['1x2'].name)).toBe(true);
  });
});

describe('SPORT_MARKETS', () => {
  it('lists the markets of each sport', () => {
    expect(SPORT_MARKETS).toEqual({
      football: ['1x2', 'dc', 'ou', 'btts', 'dnb', 'ht_1x2', 'cs'],
      basketball: ['ml', 'total'],
      tennis: ['winner'],
      volleyball: ['winner'],
    });
  });

  it('lists markets in ascending sortOrder', () => {
    for (const codes of Object.values(SPORT_MARKETS)) {
      const orders = codes.map((code) => MARKET_TYPES[code].sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length);
    }
  });

  it('lists every market type, each under its own sport (winner is shared)', () => {
    const listed = new Set(Object.values(SPORT_MARKETS).flat());
    // The handicaps are defined but not offered yet (plan task 2.1, step B).
    const notOffered: readonly MarketTypeCode[] = ['ah', 'eh'];
    expect([...listed].sort()).toEqual(ALL_TYPES.filter((t) => !notOffered.includes(t)).sort());
    for (const [sport, codes] of Object.entries(SPORT_MARKETS) as [
      SportCode,
      readonly MarketTypeCode[],
    ][]) {
      for (const code of codes) {
        if (code === 'winner') continue;
        expect(MARKET_TYPES[code].sport).toBe(sport);
      }
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SPORT_MARKETS)).toBe(true);
    expect(Object.isFrozen(SPORT_MARKETS.football)).toBe(true);
  });
});

describe('parseLine', () => {
  it('parses half-point lines', () => {
    expect(parseLine('0.5')).toBe(0.5);
    expect(parseLine('2.5')).toBe(2.5);
    expect(parseLine('10.5')).toBe(10.5);
    expect(parseLine('215.5')).toBe(215.5);
    expect(parseLine('999.5')).toBe(999.5);
  });

  it.each([
    '',
    '2',
    '2.0',
    '2.25',
    '2.75',
    '2.50',
    '-2.5',
    '+2.5',
    ' 2.5',
    '2.5 ',
    '1000.5',
    '.5',
    '2.',
    '2,5',
    'abc',
    '2.5.5',
  ])('rejects %j', (line) => {
    expect(() => parseLine(line)).toThrow(RangeError);
  });

  it('rejects non-string input at runtime', () => {
    expect(() => parseLine(2.5 as unknown as string)).toThrow(RangeError);
    expect(() => parseLine(null as unknown as string)).toThrow(RangeError);
  });

  it('maps "n.5" to n + 0.5 for every n in 0..999', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), (n) => parseLine(`${n}.5`) === n + 0.5),
    );
  });
});

describe('marketKey', () => {
  it('is the bare code for markets without a line', () => {
    for (const type of NON_LINE_TYPES) {
      expect(marketKey(type)).toBe(type);
      expect(marketKey(type, null)).toBe(type);
      expect(marketKey(type, undefined)).toBe(type);
    }
  });

  it('appends the line for line markets', () => {
    expect(marketKey('ou', '2.5')).toBe('ou:2.5');
    expect(marketKey('ou', '0.5')).toBe('ou:0.5');
    expect(marketKey('total', '215.5')).toBe('total:215.5');
  });

  it('canonicalises the line', () => {
    expect(marketKey('ou', '02.5')).toBe('ou:2.5');
    expect(marketKey('total', '000.5')).toBe('total:0.5');
  });

  it('throws when a line market has no line', () => {
    expect(() => marketKey('ou')).toThrow(RangeError);
    expect(() => marketKey('ou', null)).toThrow(RangeError);
    expect(() => marketKey('total', undefined)).toThrow(RangeError);
  });

  it('throws when a non-line market is given a line', () => {
    expect(() => marketKey('1x2', '2.5')).toThrow(RangeError);
    expect(() => marketKey('cs', '')).toThrow(RangeError);
  });

  it('throws on a malformed line', () => {
    expect(() => marketKey('ou', '2')).toThrow(RangeError);
    expect(() => marketKey('ou', '2.25')).toThrow(RangeError);
    expect(() => marketKey('total', '')).toThrow(RangeError);
  });

  it('throws on an unknown market type', () => {
    expect(() => marketKey('handicap' as MarketTypeCode)).toThrow(RangeError);
    expect(() => marketKey('toString' as MarketTypeCode)).toThrow(RangeError);
  });

  it('gives distinct lines distinct keys that round-trip', () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOTAL_TYPES), lineArb, lineArb, (type, a, b) => {
        const keyA = marketKey(type, a);
        expect(keyA).toBe(`${type}:${a}`);
        expect(parseLine(keyA.slice(type.length + 1))).toBe(parseLine(a));
        expect(keyA === marketKey(type, b)).toBe(a === b);
      }),
    );
  });
});

describe('CORRECT_SCORE_SELECTIONS', () => {
  it('has the 25 scores of the 0..4 grid plus "other"', () => {
    expect(CORRECT_SCORE_SELECTIONS).toHaveLength(26);
    expect(new Set(CORRECT_SCORE_SELECTIONS).size).toBe(26);
    expect(CORRECT_SCORE_SELECTIONS[0]).toBe('0-0');
    expect(CORRECT_SCORE_SELECTIONS.at(-1)).toBe('other');
    for (let home = 0; home <= 4; home++) {
      for (let away = 0; away <= 4; away++) {
        expect(CORRECT_SCORE_SELECTIONS).toContain(`${home}-${away}`);
      }
    }
    expect(CORRECT_SCORE_SELECTIONS).not.toContain('5-0');
    expect(CORRECT_SCORE_SELECTIONS).not.toContain('0-5');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CORRECT_SCORE_SELECTIONS)).toBe(true);
  });
});

describe('selectionsFor', () => {
  it('returns the selections of each market type', () => {
    expect(selectionsFor('1x2')).toEqual(['1', 'X', '2']);
    expect(selectionsFor('ht_1x2')).toEqual(['1', 'X', '2']);
    expect(selectionsFor('dc')).toEqual(['1X', '12', 'X2']);
    expect(selectionsFor('ou')).toEqual(['over', 'under']);
    expect(selectionsFor('total')).toEqual(['over', 'under']);
    expect(selectionsFor('btts')).toEqual(['yes', 'no']);
    expect(selectionsFor('dnb')).toEqual(['1', '2']);
    expect(selectionsFor('ml')).toEqual(['1', '2']);
    expect(selectionsFor('winner')).toEqual(['1', '2']);
    expect(selectionsFor('cs')).toBe(CORRECT_SCORE_SELECTIONS);
  });

  it('returns frozen, duplicate-free lists', () => {
    for (const type of ALL_TYPES) {
      const selections = selectionsFor(type);
      expect(Object.isFrozen(selections)).toBe(true);
      expect(new Set(selections).size).toBe(selections.length);
    }
  });

  it('throws on an unknown market type', () => {
    expect(() => selectionsFor('handicap' as MarketTypeCode)).toThrow(RangeError);
    expect(() => selectionsFor('__proto__' as MarketTypeCode)).toThrow(RangeError);
  });
});

describe('selectionLabel', () => {
  it('labels 1X2 selections with team names and Draw', () => {
    for (const type of ['1x2', 'ht_1x2'] as const) {
      expect(selectionLabel(type, '1', TEAMS)).toEqual({ en: TEAMS.home, am: TEAMS.home });
      expect(selectionLabel(type, 'X', TEAMS)).toEqual({ en: 'Draw', am: 'አቻ' });
      expect(selectionLabel(type, '2', TEAMS)).toEqual({ en: TEAMS.away, am: TEAMS.away });
    }
  });

  it('labels two-way selections with team names', () => {
    for (const type of ['dnb', 'ml', 'winner'] as const) {
      expect(selectionLabel(type, '1', TEAMS)).toEqual({ en: TEAMS.home, am: TEAMS.home });
      expect(selectionLabel(type, '2', TEAMS)).toEqual({ en: TEAMS.away, am: TEAMS.away });
    }
  });

  it('labels double chance selections', () => {
    expect(selectionLabel('dc', '1X', TEAMS)).toEqual({
      en: 'Saint George or Draw',
      am: 'Saint George ወይም አቻ',
    });
    expect(selectionLabel('dc', '12', TEAMS)).toEqual({
      en: 'Saint George or Fasil Kenema',
      am: 'Saint George ወይም Fasil Kenema',
    });
    expect(selectionLabel('dc', 'X2', TEAMS)).toEqual({
      en: 'Draw or Fasil Kenema',
      am: 'አቻ ወይም Fasil Kenema',
    });
  });

  it('labels over/under selections with the line', () => {
    expect(selectionLabel('ou', 'over', TEAMS, '2.5')).toEqual({
      en: 'Over 2.5',
      am: 'ከ2.5 በላይ',
    });
    expect(selectionLabel('ou', 'under', TEAMS, '2.5')).toEqual({
      en: 'Under 2.5',
      am: 'ከ2.5 በታች',
    });
    expect(selectionLabel('total', 'over', TEAMS, '215.5')).toEqual({
      en: 'Over 215.5',
      am: 'ከ215.5 በላይ',
    });
    expect(selectionLabel('total', 'under', TEAMS, '02.5').en).toBe('Under 2.5');
  });

  it('labels both-teams-to-score selections', () => {
    expect(selectionLabel('btts', 'yes', TEAMS)).toEqual({ en: 'Yes', am: 'አዎ' });
    expect(selectionLabel('btts', 'no', TEAMS)).toEqual({ en: 'No', am: 'አይ' });
  });

  it('labels correct-score selections', () => {
    expect(selectionLabel('cs', '2-1', TEAMS)).toEqual({ en: '2-1', am: '2-1' });
    expect(selectionLabel('cs', '0-0', TEAMS)).toEqual({ en: '0-0', am: '0-0' });
    expect(selectionLabel('cs', 'other', TEAMS)).toEqual({ en: 'Any other score', am: 'ሌላ ውጤት' });
  });

  it('gives every selection of every market a non-empty label', () => {
    for (const type of ALL_TYPES) {
      const line = sampleLine(type);
      for (const selection of selectionsFor(type)) {
        const label = selectionLabel(type, selection, TEAMS, line);
        expect(label.en.length).toBeGreaterThan(0);
        expect(label.am.length).toBeGreaterThan(0);
      }
    }
  });

  it('throws on an invalid selection', () => {
    expect(() => selectionLabel('1x2', 'over', TEAMS)).toThrow(RangeError);
    expect(() => selectionLabel('dnb', 'X', TEAMS)).toThrow(RangeError);
    expect(() => selectionLabel('cs', '5-0', TEAMS)).toThrow(RangeError);
    expect(() => selectionLabel('btts', 'Yes', TEAMS)).toThrow(RangeError);
  });

  it('throws on a missing, unexpected or malformed line', () => {
    expect(() => selectionLabel('ou', 'over', TEAMS)).toThrow(RangeError);
    expect(() => selectionLabel('total', 'under', TEAMS, null)).toThrow(RangeError);
    expect(() => selectionLabel('ou', 'over', TEAMS, '2')).toThrow(RangeError);
    expect(() => selectionLabel('1x2', '1', TEAMS, '2.5')).toThrow(RangeError);
  });
});

describe('resolveSelection', () => {
  describe('1x2', () => {
    it('settles a home win, a draw and an away win', () => {
      expect(resolveAll('1x2', finished(2, 1))).toEqual({ '1': 'won', X: 'lost', '2': 'lost' });
      expect(resolveAll('1x2', finished(1, 1))).toEqual({ '1': 'lost', X: 'won', '2': 'lost' });
      expect(resolveAll('1x2', finished(0, 3))).toEqual({ '1': 'lost', X: 'lost', '2': 'won' });
      expect(resolveAll('1x2', finished(0, 0))).toEqual({ '1': 'lost', X: 'won', '2': 'lost' });
    });
  });

  describe('dc', () => {
    it('settles each double chance against the result', () => {
      expect(resolveAll('dc', finished(2, 1))).toEqual({ '1X': 'won', '12': 'won', X2: 'lost' });
      expect(resolveAll('dc', finished(1, 1))).toEqual({ '1X': 'won', '12': 'lost', X2: 'won' });
      expect(resolveAll('dc', finished(0, 1))).toEqual({ '1X': 'lost', '12': 'won', X2: 'won' });
    });
  });

  describe('ou', () => {
    it('settles on total goals against the line', () => {
      expect(resolveAll('ou', finished(2, 1), '2.5')).toEqual({ over: 'won', under: 'lost' });
      expect(resolveAll('ou', finished(1, 1), '2.5')).toEqual({ over: 'lost', under: 'won' });
      expect(resolveAll('ou', finished(0, 0), '0.5')).toEqual({ over: 'lost', under: 'won' });
      expect(resolveAll('ou', finished(1, 0), '0.5')).toEqual({ over: 'won', under: 'lost' });
      expect(resolveAll('ou', finished(3, 3), '5.5')).toEqual({ over: 'won', under: 'lost' });
    });

    it('requires a valid line', () => {
      expect(() => resolve('ou', 'over', finished(1, 1))).toThrow(RangeError);
      expect(() => resolve('ou', 'over', finished(1, 1), null)).toThrow(RangeError);
      expect(() => resolve('ou', 'over', finished(1, 1), '2')).toThrow(RangeError);
      expect(() => resolve('ou', 'over', finished(1, 1), '2.25')).toThrow(RangeError);
    });
  });

  describe('total', () => {
    it('settles on total points against the line', () => {
      expect(resolveAll('total', finished(110, 106), '215.5')).toEqual({
        over: 'won',
        under: 'lost',
      });
      expect(resolveAll('total', finished(100, 115), '215.5')).toEqual({
        over: 'lost',
        under: 'won',
      });
    });

    it('requires a line', () => {
      expect(() => resolve('total', 'under', finished(100, 99))).toThrow(RangeError);
    });
  });

  describe('btts', () => {
    it('is yes only when both teams score', () => {
      expect(resolveAll('btts', finished(1, 1))).toEqual({ yes: 'won', no: 'lost' });
      expect(resolveAll('btts', finished(3, 2))).toEqual({ yes: 'won', no: 'lost' });
      expect(resolveAll('btts', finished(2, 0))).toEqual({ yes: 'lost', no: 'won' });
      expect(resolveAll('btts', finished(0, 2))).toEqual({ yes: 'lost', no: 'won' });
      expect(resolveAll('btts', finished(0, 0))).toEqual({ yes: 'lost', no: 'won' });
    });
  });

  describe('dnb', () => {
    it('settles the winner and voids a draw', () => {
      expect(resolveAll('dnb', finished(2, 0))).toEqual({ '1': 'won', '2': 'lost' });
      expect(resolveAll('dnb', finished(1, 2))).toEqual({ '1': 'lost', '2': 'won' });
      expect(resolveAll('dnb', finished(1, 1))).toEqual({ '1': 'void', '2': 'void' });
      expect(resolveAll('dnb', finished(0, 0))).toEqual({ '1': 'void', '2': 'void' });
    });
  });

  describe('ht_1x2', () => {
    it('settles on the half-time score, not the full-time score', () => {
      expect(resolveAll('ht_1x2', finished(1, 2, [1, 0]))).toEqual({
        '1': 'won',
        X: 'lost',
        '2': 'lost',
      });
      expect(resolveAll('ht_1x2', finished(3, 0, [0, 0]))).toEqual({
        '1': 'lost',
        X: 'won',
        '2': 'lost',
      });
      expect(resolveAll('ht_1x2', finished(2, 2, [0, 1]))).toEqual({
        '1': 'lost',
        X: 'lost',
        '2': 'won',
      });
    });

    it('throws when the half-time score is missing', () => {
      expect(() => resolve('ht_1x2', '1', finished(1, 0))).toThrow(RangeError);
      const partial = (htHome: number | null | undefined, htAway: number | null | undefined) =>
        resolve('ht_1x2', 'X', { status: 'finished', score: { home: 1, away: 1, htHome, htAway } });
      expect(() => partial(null, 0)).toThrow(RangeError);
      expect(() => partial(0, null)).toThrow(RangeError);
      expect(() => partial(undefined, 0)).toThrow(RangeError);
      expect(() => partial(null, null)).toThrow(RangeError);
      expect(partial(0, 0)).toBe('won');
    });

    it('does not need the half-time score for full-time markets', () => {
      const score: FinalScore = { home: 1, away: 0, htHome: null, htAway: null };
      expect(resolve('1x2', '1', { status: 'finished', score })).toBe('won');
    });
  });

  describe('cs', () => {
    it('wins only for the exact score inside the grid', () => {
      const results = resolveAll('cs', finished(2, 1));
      expect(results['2-1']).toBe('won');
      expect(results['1-2']).toBe('lost');
      expect(results.other).toBe('lost');
      expect(Object.values(results).filter((r) => r === 'won')).toHaveLength(1);
      expect(resolve('cs', '0-0', finished(0, 0))).toBe('won');
      expect(resolve('cs', '4-4', finished(4, 4))).toBe('won');
      expect(resolve('cs', 'other', finished(4, 4))).toBe('lost');
    });

    it('settles "other" for any score outside the 0..4 grid', () => {
      expect(resolve('cs', 'other', finished(5, 0))).toBe('won');
      expect(resolve('cs', 'other', finished(0, 5))).toBe('won');
      expect(resolve('cs', 'other', finished(7, 6))).toBe('won');
      expect(resolve('cs', '4-0', finished(5, 0))).toBe('lost');
      expect(resolve('cs', '4-4', finished(5, 5))).toBe('lost');
    });
  });

  describe('ml and winner', () => {
    it('settles the winner', () => {
      expect(resolveAll('ml', finished(101, 99))).toEqual({ '1': 'won', '2': 'lost' });
      expect(resolveAll('ml', finished(88, 104))).toEqual({ '1': 'lost', '2': 'won' });
      expect(resolveAll('winner', finished(2, 0))).toEqual({ '1': 'won', '2': 'lost' });
      expect(resolveAll('winner', finished(1, 3))).toEqual({ '1': 'lost', '2': 'won' });
    });

    it('throws on a tie in a finished match', () => {
      expect(() => resolve('ml', '1', finished(100, 100))).toThrow(RangeError);
      expect(() => resolve('winner', '2', finished(1, 1))).toThrow(RangeError);
      expect(() => resolve('winner', '1', finished(0, 0))).toThrow(RangeError);
    });

    it('still voids a tie-free market when the match is cancelled', () => {
      expect(resolve('ml', '1', { status: 'cancelled' })).toBe('void');
    });
  });

  describe('void statuses', () => {
    it.each(VOID_STATUSES)('voids every selection of every market when %s', (status) => {
      for (const type of ALL_TYPES) {
        const line = sampleLine(type);
        for (const selection of selectionsFor(type)) {
          expect(resolve(type, selection, { status }, line)).toBe('void');
        }
      }
    });

    it('still validates the market and selection of a void event', () => {
      expect(() => resolve('1x2', 'over', { status: 'cancelled' })).toThrow(RangeError);
      expect(() => resolve('ou', 'over', { status: 'postponed' })).toThrow(RangeError);
      expect(() => resolve('1x2', '1', { status: 'abandoned' }, '2.5')).toThrow(RangeError);
    });
  });

  describe('validation', () => {
    it('throws on a selection outside the market', () => {
      expect(() => resolve('1x2', '3', finished(1, 0))).toThrow(RangeError);
      expect(() => resolve('1x2', 'x', finished(1, 0))).toThrow(RangeError);
      expect(() => resolve('dnb', 'X', finished(1, 0))).toThrow(RangeError);
      expect(() => resolve('dc', '21', finished(1, 0))).toThrow(RangeError);
      expect(() => resolve('cs', '5-0', finished(5, 0))).toThrow(RangeError);
      expect(() => resolve('cs', '1-0 ', finished(1, 0))).toThrow(RangeError);
      expect(() => resolve('ou', 'yes', finished(1, 0), '2.5')).toThrow(RangeError);
    });

    it('throws when a non-line market is given a line', () => {
      expect(() => resolve('1x2', '1', finished(1, 0), '2.5')).toThrow(RangeError);
    });

    it('throws on an unknown market type', () => {
      expect(() => resolve('handicap' as MarketTypeCode, '1', finished(1, 0))).toThrow(RangeError);
    });

    it.each([
      [-1, 0],
      [0, -1],
      [1.5, 0],
      [0, 0.5],
      [Number.NaN, 0],
      [0, Number.POSITIVE_INFINITY],
      [2 ** 53, 0],
    ])('throws on an invalid full-time score %d-%d', (home, away) => {
      for (const type of ALL_TYPES) {
        const line = sampleLine(type);
        expect(() => resolve(type, selectionsFor(type)[0]!, finished(home, away), line)).toThrow(
          RangeError,
        );
      }
    });

    it('throws on a non-numeric score', () => {
      const score = { home: '1', away: 0 } as unknown as FinalScore;
      expect(() => resolve('1x2', '1', { status: 'finished', score })).toThrow(RangeError);
      const missing = undefined as unknown as FinalScore;
      expect(() => resolve('1x2', '1', { status: 'finished', score: missing })).toThrow(RangeError);
    });

    it('throws on an invalid half-time score, even for full-time markets', () => {
      expect(() => resolve('1x2', '1', finished(2, 0, [-1, 0]))).toThrow(RangeError);
      expect(() => resolve('ht_1x2', '1', finished(2, 0, [1.5, 0]))).toThrow(RangeError);
    });

    it('throws when the half-time score exceeds the full-time score', () => {
      expect(() => resolve('ht_1x2', '1', finished(1, 0, [2, 0]))).toThrow(RangeError);
      expect(() => resolve('1x2', '1', finished(1, 0, [0, 1]))).toThrow(RangeError);
    });

    it('throws on an unknown status', () => {
      const input = { status: 'suspended' } as unknown as ResolutionInput;
      expect(() => resolve('1x2', '1', input)).toThrow(RangeError);
    });
  });

  describe('properties', () => {
    it('exactly one of 1/X/2 wins for every finished football score', () => {
      fc.assert(
        fc.property(goalsArb, goalsArb, (home, away) => {
          const results = Object.values(resolveAll('1x2', finished(home, away)));
          expect(results.filter((r) => r === 'won')).toHaveLength(1);
          expect(results.filter((r) => r === 'lost')).toHaveLength(2);
        }),
      );
    });

    it('exactly one correct-score selection wins for every finished score', () => {
      fc.assert(
        fc.property(goalsArb, goalsArb, (home, away) => {
          const results = resolveAll('cs', finished(home, away));
          const won = Object.keys(results).filter((s) => results[s] === 'won');
          expect(won).toEqual([home <= 4 && away <= 4 ? `${home}-${away}` : 'other']);
          expect(Object.values(results).filter((r) => r === 'void')).toHaveLength(0);
        }),
      );
    });

    it('exactly one of over/under wins for any half-point line', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...TOTAL_TYPES),
          pointsArb,
          pointsArb,
          lineArb,
          (type, home, away, line) => {
            const results = resolveAll(type, finished(home, away), line);
            expect([results.over, results.under].sort()).toEqual(['lost', 'won']);
            expect(results.over === 'won').toBe(home + away > parseLine(line));
          },
        ),
      );
    });

    it('double chance is consistent with 1x2', () => {
      fc.assert(
        fc.property(goalsArb, goalsArb, (home, away) => {
          const input = finished(home, away);
          const wins = (selection: string) => resolve('1x2', selection, input) === 'won';
          const dc = resolveAll('dc', input);
          expect(dc['1X'] === 'won').toBe(wins('1') || wins('X'));
          expect(dc['12'] === 'won').toBe(wins('1') || wins('2'));
          expect(dc.X2 === 'won').toBe(wins('X') || wins('2'));
          expect(Object.values(dc).filter((r) => r === 'won')).toHaveLength(2);
        }),
      );
    });

    it('draw no bet is 1x2 with the draw refunded', () => {
      fc.assert(
        fc.property(goalsArb, goalsArb, (home, away) => {
          const input = finished(home, away);
          const draw = resolve('1x2', 'X', input) === 'won';
          for (const selection of ['1', '2']) {
            expect(resolve('dnb', selection, input)).toBe(
              draw ? 'void' : resolve('1x2', selection, input),
            );
          }
        }),
      );
    });

    it('half-time result is 1x2 on the half-time score', () => {
      fc.assert(
        fc.property(scoreWithHtArb, (score) => {
          const htOnly = finished(score.htHome!, score.htAway!);
          for (const selection of ['1', 'X', '2']) {
            expect(resolve('ht_1x2', selection, { status: 'finished', score })).toBe(
              resolve('1x2', selection, htOnly),
            );
          }
        }),
      );
    });

    it('full-time markets ignore a consistent half-time score', () => {
      fc.assert(
        fc.property(marketArb, scoreWithHtArb, (market, score) => {
          const twoWay = market.type === 'ml' || market.type === 'winner';
          fc.pre(market.type !== 'ht_1x2' && !(twoWay && score.home === score.away));
          const withHt: ResolutionInput = { status: 'finished', score };
          const withoutHt = finished(score.home, score.away);
          for (const selection of selectionsFor(market.type)) {
            expect(resolveSelection(market, selection, withHt)).toBe(
              resolveSelection(market, selection, withoutHt),
            );
          }
        }),
      );
    });

    it('both teams to score: exactly one of yes/no wins', () => {
      fc.assert(
        fc.property(goalsArb, goalsArb, (home, away) => {
          const results = resolveAll('btts', finished(home, away));
          expect([results.yes, results.no].sort()).toEqual(['lost', 'won']);
          expect(results.yes === 'won').toBe(home > 0 && away > 0);
        }),
      );
    });

    it('two-way winner markets match 1x2 when there is no tie', () => {
      fc.assert(
        fc.property(
          fc.constantFrom<MarketTypeCode>('ml', 'winner'),
          pointsArb,
          pointsArb,
          (type, home, away) => {
            fc.pre(home !== away);
            const input = finished(home, away);
            const results = resolveAll(type, input);
            expect(results['1']).toBe(resolve('1x2', '1', input));
            expect(results['2']).toBe(resolve('1x2', '2', input));
            expect(Object.values(results).filter((r) => r === 'won')).toHaveLength(1);
          },
        ),
      );
    });

    it('everything is void when the event does not finish', () => {
      fc.assert(
        fc.property(marketArb, fc.constantFrom(...VOID_STATUSES), (market, status) => {
          for (const selection of selectionsFor(market.type)) {
            expect(resolveSelection(market, selection, { status })).toBe('void');
          }
        }),
      );
    });

    it('never voids a finished event except a draw-no-bet draw or an Asian handicap push', () => {
      fc.assert(
        fc.property(marketArb, scoreWithHtArb, (market, score) => {
          fc.pre(market.type !== 'ml' && market.type !== 'winner');
          const isDnbDraw = market.type === 'dnb' && score.home === score.away;
          const isAhPush = market.type === 'ah' && score.home + Number(market.line) === score.away;
          for (const selection of selectionsFor(market.type)) {
            const result = resolveSelection(market, selection, { status: 'finished', score });
            expect(result === 'void').toBe(isDnbDraw || isAhPush);
          }
        }),
      );
    });
  });
});

describe('handicap markets', () => {
  it('parses half and whole handicaps, canonical and signed either way', () => {
    expect(parseHandicap('-1.5')).toBe(-1.5);
    expect(parseHandicap('+0.5')).toBe(0.5);
    expect(parseHandicap('0')).toBe(0);
    expect(Object.is(parseHandicap('-0'), 0)).toBe(true);
    expect(parseHandicap('12')).toBe(12);
    expect(parseHandicap(String(MAX_HANDICAP))).toBe(MAX_HANDICAP);
  });

  it('rejects quarter lines, other text and lines out of range', () => {
    for (const line of [
      '-0.25',
      '0.75',
      '1.0',
      '1.50',
      '',
      ' 1',
      'one',
      '--1',
      '21',
      '-20.5',
      '123',
    ]) {
      expect(() => parseHandicap(line)).toThrow(RangeError);
    }
    expect(() => parseHandicap(2 as unknown as string)).toThrow(RangeError);
  });

  it('accepts only non-zero whole lines for the three-way handicap', () => {
    expect(parseHandicap('-2', { wholeOnly: true })).toBe(-2);
    expect(parseHandicap('+1', { wholeOnly: true })).toBe(1);
    for (const line of ['0', '-0', '0.5', '-1.5']) {
      expect(() => parseHandicap(line, { wholeOnly: true })).toThrow(RangeError);
    }
  });

  it('formats a handicap the way a bettor reads it', () => {
    expect(formatHandicap(1.5)).toBe('+1.5');
    expect(formatHandicap(-1)).toBe('-1');
    expect(formatHandicap(0)).toBe('0');
    expect(formatHandicap(-0)).toBe('0');
  });

  it('keys handicap markets by their canonical line', () => {
    expect(marketKey('ah', '-1.5')).toBe('ah:-1.5');
    expect(marketKey('ah', '+1.5')).toBe('ah:1.5');
    expect(marketKey('ah', '-0')).toBe('ah:0');
    expect(marketKey('eh', '+1')).toBe('eh:1');
    expect(() => marketKey('eh', '0')).toThrow(RangeError);
    expect(() => marketKey('ah', '2.25')).toThrow(RangeError);
    expect(() => marketKey('ah')).toThrow(RangeError);
  });

  it('labels each side with its own handicap', () => {
    expect(selectionLabel('ah', '1', TEAMS, '-1.5')).toEqual({
      en: 'Saint George -1.5',
      am: 'Saint George -1.5',
    });
    expect(selectionLabel('ah', '2', TEAMS, '-1.5').en).toBe('Fasil Kenema +1.5');
    expect(selectionLabel('ah', '1', TEAMS, '0').en).toBe('Saint George 0');
    expect(selectionLabel('eh', '1', TEAMS, '-1').en).toBe('Saint George (-1)');
    expect(selectionLabel('eh', 'X', TEAMS, '-1')).toEqual({ en: 'Draw (-1)', am: 'አቻ (-1)' });
    expect(selectionLabel('eh', '2', TEAMS, '-1').en).toBe('Fasil Kenema (+1)');
  });

  it('settles worked examples', () => {
    // Home -1.5: needs to win by two.
    expect(resolveAll('ah', finished(2, 0), '-1.5')).toEqual({ '1': 'won', '2': 'lost' });
    expect(resolveAll('ah', finished(1, 0), '-1.5')).toEqual({ '1': 'lost', '2': 'won' });
    // Home -1: winning by exactly one is a push, both selections void.
    expect(resolveAll('ah', finished(2, 1), '-1')).toEqual({ '1': 'void', '2': 'void' });
    expect(resolveAll('ah', finished(3, 1), '-1')).toEqual({ '1': 'won', '2': 'lost' });
    // Away +0.5 (home -0.5) wins on a draw.
    expect(resolveAll('ah', finished(1, 1), '-0.5')).toEqual({ '1': 'lost', '2': 'won' });
    // Three-way, home -1: a one-goal home win is the handicap draw.
    expect(resolveAll('eh', finished(2, 1), '-1')).toEqual({ '1': 'lost', X: 'won', '2': 'lost' });
    expect(resolveAll('eh', finished(0, 0), '+1')).toEqual({ '1': 'won', X: 'lost', '2': 'lost' });
  });

  it('Asian handicap: half lines never push, exactly one side wins', () => {
    fc.assert(
      fc.property(goalsArb, goalsArb, fc.integer({ min: -6, max: 5 }), (home, away, n) => {
        const line = String(n + 0.5);
        const results = resolveAll('ah', finished(home, away), line);
        expect([results['1'], results['2']].sort()).toEqual(['lost', 'won']);
        expect(results['1'] === 'won').toBe(home - away + n + 0.5 > 0);
      }),
    );
  });

  it('Asian handicap: whole lines void both sides exactly on a level adjusted score', () => {
    fc.assert(
      fc.property(goalsArb, goalsArb, fc.integer({ min: -6, max: 6 }), (home, away, n) => {
        const results = resolveAll('ah', finished(home, away), String(n));
        if (home + n === away) {
          expect(results).toEqual({ '1': 'void', '2': 'void' });
        } else {
          expect([results['1'], results['2']].sort()).toEqual(['lost', 'won']);
        }
      }),
    );
  });

  it('Asian handicap is symmetric: home at L is away at -L with the teams swapped', () => {
    fc.assert(
      fc.property(goalsArb, goalsArb, ahLineArb, (home, away, line) => {
        const mirrored = String(-Number(line) + 0);
        expect(resolve('ah', '1', finished(home, away), line)).toBe(
          resolve('ah', '2', finished(away, home), mirrored),
        );
      }),
    );
  });

  it('Asian handicap 0 is draw no bet', () => {
    fc.assert(
      fc.property(goalsArb, goalsArb, (home, away) => {
        expect(resolveAll('ah', finished(home, away), '0')).toEqual(
          resolveAll('dnb', finished(home, away)),
        );
      }),
    );
  });

  it('three-way handicap: exactly one of 1/X/2 wins, the draw on a level adjusted score', () => {
    fc.assert(
      fc.property(goalsArb, goalsArb, ehLineArb, (home, away, line) => {
        const results = resolveAll('eh', finished(home, away), line);
        expect(Object.values(results).filter((r) => r === 'won')).toHaveLength(1);
        expect(results.X === 'won').toBe(home + Number(line) === away);
      }),
    );
  });

  it('is never decided before full time', () => {
    fc.assert(
      fc.property(goalsArb, goalsArb, ahLineArb, ehLineArb, (home, away, ah, eh) => {
        expect(certainMarketResult({ type: 'ah', line: ah }, { home, away })).toBeNull();
        expect(certainMarketResult({ type: 'eh', line: eh }, { home, away })).toBeNull();
      }),
    );
  });
});

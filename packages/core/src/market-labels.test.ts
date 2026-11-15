import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FACTORY_MARKETS, LEGACY_FOOTBALL_TYPES } from './market-factory';
import {
  FACTORY_LABELS_AMHARIC_PENDING,
  factoryMarketName,
  factorySelectionLabel,
} from './market-labels';
import { MARKET_TYPES, type MarketTypeCode, selectionLabel, selectionsFor } from './markets';

const TEAMS = { home: 'Arsenal', away: 'Chelsea' };

const label = (type: string, selection: string, line?: string | null) =>
  factorySelectionLabel(type, selection, TEAMS, line).en;

describe('catalogue coverage', () => {
  it('names every market and labels every selection, uniquely within a market', () => {
    for (const market of FACTORY_MARKETS) {
      const name = factoryMarketName(market.type, market.line);
      expect(name.en.trim(), market.type).not.toBe('');
      expect(name.am.trim(), market.type).not.toBe('');
      const seen = new Set<string>();
      for (const selection of market.selections) {
        const text = factorySelectionLabel(market.type, selection, TEAMS, market.line);
        expect(text.en.trim(), `${market.type} ${selection}`).not.toBe('');
        expect(text.am.trim(), `${market.type} ${selection}`).not.toBe('');
        expect(seen.has(text.en), `${market.type} ${market.line} ${selection}`).toBe(false);
        seen.add(text.en);
      }
    }
  });

  it('keeps labels unique for any two different team names', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string({ minLength: 1, maxLength: 12 }),
        (home, away) => {
          fc.pre(home.trim() !== '' && away.trim() !== '' && !home.includes(away));
          fc.pre(!away.includes(home) && !/[&/]| or | by /.test(home + away));
          for (const market of FACTORY_MARKETS) {
            const texts = market.selections.map(
              (s) => factorySelectionLabel(market.type, s, { home, away }, market.line).en,
            );
            expect(new Set(texts).size).toBe(texts.length);
          }
        },
      ),
      { numRuns: 15 },
    );
  });

  it('flags the Amharic translation as pending', () => {
    expect(FACTORY_LABELS_AMHARIC_PENDING).toBe(true);
  });
});

describe('legacy types', () => {
  it('give exactly MARKET_TYPES names and selectionLabel labels', () => {
    for (const type of Object.keys(MARKET_TYPES) as MarketTypeCode[]) {
      expect(factoryMarketName(type)).toEqual(MARKET_TYPES[type].name);
    }
    for (const type of LEGACY_FOOTBALL_TYPES as MarketTypeCode[]) {
      const lines = FACTORY_MARKETS.filter((m) => m.type === type).map((m) => m.line);
      for (const line of lines) {
        for (const selection of selectionsFor(type)) {
          expect(factorySelectionLabel(type, selection, TEAMS, line)).toEqual(
            selectionLabel(type, selection, TEAMS, line),
          );
        }
      }
    }
  });
});

describe('names', () => {
  it('append the line where there is one', () => {
    expect(factoryMarketName('home_ou', '2.5').en).toBe('Home total goals 2.5');
    expect(factoryMarketName('multigoals', '1-3').en).toBe('Multigoals 1-3');
    expect(factoryMarketName('h1_dc_ou', '1.5').en).toBe('1st half double chance & total 1.5');
    expect(factoryMarketName('ft_1x2_btts').en).toBe('1X2 & both teams to score');
    expect(factoryMarketName('htft').en).toBe('Half time / full time');
    expect(factoryMarketName('h1_ah', '1.5').en).toBe('1st half Asian handicap +1.5');
    expect(factoryMarketName('h1_ah', '-1.5').en).toBe('1st half Asian handicap -1.5');
  });

  it('keeps English text in Amharic for factory-only markets', () => {
    const name = factoryMarketName('htft');
    expect(name.am).toBe(name.en);
  });
});

describe('selection labels', () => {
  it('joins combinations readably', () => {
    expect(label('ft_1x2_btts', '1&yes')).toBe('Arsenal & Yes');
    expect(label('ft_dc_ou', '1X&over', '2.5')).toBe('Arsenal or Draw & Over 2.5');
    expect(label('ft_btts_ou', 'no&under', '2.5')).toBe('No & Under 2.5');
    expect(label('htft_ou', 'X/2&over', '1.5')).toBe('Draw/Chelsea & Over 1.5');
  });

  it('labels half time / full time', () => {
    expect(label('htft', 'X/1')).toBe('Draw/Arsenal');
    expect(label('h1_h2_1x2', '2/2')).toBe('Chelsea/Chelsea');
    expect(label('h1_h2_ou', 'over/under', '1.5')).toBe('Over 1.5/Under 1.5');
    expect(label('h1_h2_btts', 'yes/no')).toBe('Yes/No');
  });

  it('labels winning margins, goal ranges and exact goals', () => {
    expect(label('winning_margin', '1by3+')).toBe('Arsenal by 3+');
    expect(label('winning_margin', '2by1')).toBe('Chelsea by 1');
    expect(label('winning_margin', 'X')).toBe('Draw');
    expect(label('h1_winning_margin', '2by2+')).toBe('Chelsea by 2+');
    expect(label('goal_range', '2-3')).toBe('2-3 goals');
    expect(label('goal_range', '6+')).toBe('6+ goals');
    expect(label('exact_goals', '1')).toBe('1 goal');
    expect(label('exact_goals', '6+')).toBe('6+ goals');
  });

  it('labels multigoals, team markets and handicaps', () => {
    expect(label('multigoals', 'yes', '1-3')).toBe('Yes');
    expect(label('home_multigoals', 'no', '0-1')).toBe('No');
    expect(label('home_ou', 'over', '1.5')).toBe('Over 1.5');
    expect(label('away_highest_scoring_half', '2nd')).toBe('2nd half');
    expect(label('home_no_bet', '2')).toBe('Chelsea');
    expect(label('away_odd_even', 'odd')).toBe('Odd');
    expect(label('h1_ah', '1', '-1.5')).toBe('Arsenal -1.5');
    expect(label('h1_eh', 'X', '1')).toBe('Draw (+1)');
    expect(label('asian_total', 'under', '2')).toBe('Under 2');
  });

  it('labels half-time score / full-time result and other scores', () => {
    expect(label('htcs_ft_result', '1-0/1')).toBe('1-0/Arsenal');
    expect(label('htcs_ft_result', '0-1/X')).toBe('0-1/Draw');
    expect(label('htcs_ft_result', 'other')).toBe('Any other');
    expect(label('h1_cs', '2-1')).toBe('2-1');
    expect(label('h1_cs', 'other')).toBe('Any other score');
  });

  it('reuses markets.ts Amharic only for whole labels', () => {
    const am = (type: string, selection: string, line?: string | null) =>
      factorySelectionLabel(type, selection, TEAMS, line).am;
    expect(am('h1_dnb', '1')).toBe('Arsenal');
    expect(am('h1_ou', 'over', '1.5')).toBe('ከ1.5 በላይ');
    expect(am('h1_btts', 'yes')).toBe('አዎ');
    expect(am('h1_btts', 'no')).toBe('አይ');
    expect(am('home_no_bet', 'X')).toBe('አቻ');
    expect(am('h1_cs', 'other')).toBe('ሌላ ውጤት');
    expect(am('ft_1x2_btts', '1&yes')).toBe('Arsenal & Yes');
    expect(am('goal_range', '2-3')).toBe('2-3 goals');
  });
});

describe('invalid input', () => {
  it('throws a RangeError for an unknown market, line or selection', () => {
    expect(() => factoryMarketName('nope')).toThrow(RangeError);
    expect(() => factoryMarketName('multigoals', '9-9')).toThrow(RangeError);
    expect(() => factoryMarketName('multigoals')).toThrow(RangeError);
    expect(() => factorySelectionLabel('nope', '1', TEAMS)).toThrow(RangeError);
    expect(() => factorySelectionLabel('htft', 'yes', TEAMS)).toThrow(RangeError);
    expect(() => factorySelectionLabel('ft_1x2_ou', '1&under', TEAMS, '0.5')).toThrow(RangeError);
    expect(() => factorySelectionLabel('h1_ou', 'over', TEAMS)).toThrow(RangeError);
    expect(() => factorySelectionLabel('1x2', 'yes', TEAMS)).toThrow(RangeError);
  });
});

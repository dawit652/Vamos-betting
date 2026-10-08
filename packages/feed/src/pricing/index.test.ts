import { SPORT_MARKETS, type SportCode } from '@vamos/core';
import { describe, expect, it } from 'vitest';
import { expectedPoints } from './basketball';
import { expectedGoals } from './football';
import { matchStrengths, priceMatch } from './index';
import { DEFAULT_PLAYER_RATING } from './tennis';

describe('matchStrengths', () => {
  it('reads attack / defence for football and offence / defence for basketball', () => {
    const home = { attack: 1.3, defence: 0.8 };
    const away = { attack: 0.9, defence: 1.1 };
    expect(matchStrengths('football', home, away)).toEqual(expectedGoals(home, away));
    expect(
      matchStrengths(
        'basketball',
        { offence: 1.08, defence: 0.95 },
        { offence: 0.97, defence: 1.04 },
      ),
    ).toEqual(expectedPoints({ attack: 1.08, defence: 0.95 }, { attack: 0.97, defence: 1.04 }));
    // Either spelling works for either sport.
    expect(matchStrengths('basketball', home, away)).toEqual(expectedPoints(home, away));
    expect(matchStrengths('football', { offence: 1.3, defence: 0.8 }, away)).toEqual(
      expectedGoals(home, away),
    );
  });

  it('reads the Elo-like rating for tennis and volleyball', () => {
    expect(matchStrengths('tennis', { rating: 2100 }, { rating: 1700 })).toEqual({
      home: 2100,
      away: 1700,
    });
    expect(matchStrengths('volleyball', null, undefined)).toEqual({
      home: DEFAULT_PLAYER_RATING,
      away: DEFAULT_PLAYER_RATING,
    });
  });

  it('falls back to neutral values for missing or invalid ratings', () => {
    const neutral = { attack: 1, defence: 1 };
    expect(matchStrengths('football', {}, { attack: -2, defence: Number.NaN })).toEqual(
      expectedGoals(neutral, neutral),
    );
    expect(matchStrengths('football', null, null)).toEqual(expectedGoals(neutral, neutral));
  });
});

describe('priceMatch', () => {
  it.each<[SportCode, { home: number; away: number }]>([
    ['football', { home: 1.5, away: 1.2 }],
    ['basketball', { home: 101, away: 97 }],
    ['tennis', { home: 1900, away: 1850 }],
    ['volleyball', { home: 1700, away: 1800 }],
  ])('prices the %s markets', (sport, strengths) => {
    const markets = priceMatch(sport, strengths);
    const types = new Set(markets.map((m) => m.type));
    expect([...types]).toEqual([...SPORT_MARKETS[sport]]);
  });

  it('passes the live state and margin through', () => {
    const live = priceMatch(
      'football',
      { home: 1.5, away: 1.2 },
      {
        state: { minute: 30, home: 1, away: 1 },
      },
    );
    expect(live.some((m) => m.type === 'btts')).toBe(false);
    const fair = priceMatch('tennis', { home: 1800, away: 1800 }, { marginBps: 0 });
    expect(fair[0]?.selections[0]?.oddsMilli).toBe(2000);
  });

  it('rejects an unknown sport', () => {
    expect(() => priceMatch('cricket' as SportCode, { home: 1, away: 1 })).toThrow(RangeError);
    expect(() => matchStrengths('cricket' as SportCode, null, null)).toThrow(RangeError);
  });
});

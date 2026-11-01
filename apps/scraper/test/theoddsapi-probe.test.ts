import { describe, expect, it } from 'vitest';
import { analyseOdds, isUsableKey, redact, type OddsEvent } from '../src/cli/theoddsapi-probe';

const NOW = new Date('2026-11-07T12:00:00Z');

function event(id: string, kickoff: string, books: OddsEvent['bookmakers']): OddsEvent {
  return {
    id,
    commence_time: kickoff,
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    bookmakers: books,
  };
}

const h2h = (home: number, draw: number, away: number, at = '2026-11-07T11:50:00Z') => ({
  key: 'h2h',
  last_update: at,
  outcomes: [
    { name: 'Arsenal', price: home },
    { name: 'Draw', price: draw },
    { name: 'Chelsea', price: away },
  ],
});
const totals = (point: number) => ({
  key: 'totals',
  outcomes: [
    { name: 'Over', price: 1.9, point },
    { name: 'Under', price: 1.95, point },
  ],
});

describe('theoddsapi probe', () => {
  it('redacts raw and encoded keys', () => {
    expect(redact('https://x/?apiKey=ab+c/d&x=1', 'ab+c/d')).toBe('https://x/?apiKey=***&x=1');
    expect(redact('apiKey=ab%2Bc%2Fd', 'ab+c/d')).toBe('apiKey=***');
    expect(redact('nothing', '')).toBe('nothing');
  });

  it('accepts only printable keys of a sane length', () => {
    expect(isUsableKey('0123456789abcdef')).toBe(true);
    expect(isUsableKey(undefined)).toBe(false);
    expect(isUsableKey('short')).toBe(false);
    expect(isUsableKey('has space 1234')).toBe(false);
    expect(isUsableKey('line\nbreak1234')).toBe(false);
  });

  it('counts complete 1X2s, the 2.5 line, overround and age; skips live events', () => {
    const r = analyseOdds(
      [
        event('a', '2026-11-07T15:00:00Z', [
          { key: 'pinnacle', markets: [h2h(2, 3.5, 4), totals(2.5)] },
          { key: 'smarkets', markets: [h2h(2.1, 3.6, 4.2), totals(3.5)] },
          {
            key: 'williamhill',
            markets: [{ key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2 }] }],
          },
        ]),
        event('live', '2026-11-07T11:00:00Z', [{ key: 'pinnacle', markets: [h2h(2, 3.5, 4)] }]),
      ],
      NOW,
    );
    expect(r.events).toBe(2);
    expect(r.prematch).toBe(1);
    expect(r.booksH2h).toEqual([2]);
    expect(r.books25).toEqual([1]);
    expect(r.totalsPoints).toEqual({ '2.5': 1, '3.5': 1 });
    expect(r.perBook.pinnacle).toMatchObject({ events: 1, h2hComplete: 1, line25: 1, ageMin: 10 });
    // 1/2 + 1/3.5 + 1/4 − 1 = 3.571…%
    expect(r.perBook.pinnacle?.overroundPct).toBeCloseTo(3.57, 2);
    expect(r.perBook.williamhill).toMatchObject({ h2hComplete: 0, line25: 0 });
    expect(r.missingBooks).toContain('betfair_ex_uk');
    expect(r.missingBooks).not.toContain('pinnacle');
  });
});

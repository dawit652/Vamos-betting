import { describe, expect, it } from 'vitest';
import {
  analyseAltTotals,
  analyseOdds,
  isHalfLine,
  isUsableKey,
  onlyBooks,
  redact,
  type OddsEvent,
} from '../src/cli/theoddsapi-probe';

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

describe('theoddsapi probe: lines the pricing can use', () => {
  it('counts events with a 2.5 consensus and with two books on any x.5 line', () => {
    const r = analyseOdds(
      [
        event('two-on-2.5', '2026-11-07T15:00:00Z', [
          { key: 'williamhill', markets: [h2h(2, 3.5, 4), totals(2.5)] },
          { key: 'onexbet', markets: [h2h(2, 3.5, 4), totals(2.5)] },
        ]),
        event('two-on-3.5', '2026-11-07T17:30:00Z', [
          { key: 'marathonbet', markets: [h2h(2, 3.5, 4), totals(3.5)] },
          { key: 'onexbet', markets: [h2h(2, 3.5, 4), totals(3.5)] },
          { key: 'pinnacle', markets: [h2h(2, 3.5, 4), totals(2.75)] },
        ]),
      ],
      NOW,
    );
    expect(r.with25).toBe(1);
    expect(r.withAnyHalf).toBe(2);
    expect(r.books25).toEqual([2, 0]);
    expect(r.perBook.onexbet?.lines).toEqual({ '2.5': 1, '3.5': 1 });
    // A quarter line is listed but never counts as an x.5 line.
    expect(r.perBook.pinnacle?.lines).toEqual({ '2.75': 1 });
    expect(r.detail[1]?.halfLines).toEqual({ '3.5': 2 });
  });

  it('tells x.5 lines from whole and quarter lines', () => {
    expect([0.5, 2.5, 3.5].every(isHalfLine)).toBe(true);
    expect([2, 2.25, 2.75, 3].some(isHalfLine)).toBe(false);
  });

  it('reads per-event alternate_totals', () => {
    const a = analyseAltTotals(
      event('e', '2026-11-07T15:00:00Z', [
        {
          key: 'pinnacle',
          markets: [
            {
              key: 'alternate_totals',
              outcomes: [
                { name: 'Over', price: 1.5, point: 1.5 },
                { name: 'Under', price: 2.6, point: 1.5 },
                { name: 'Over', price: 2.0, point: 2.5 },
                { name: 'Under', price: 1.85, point: 2.5 },
                { name: 'Over', price: 3.4, point: 3.5 },
              ],
            },
          ],
        },
        { key: 'smarkets', markets: [] },
      ]),
    );
    expect(a).toEqual({ books: { pinnacle: [1.5, 2.5] }, with25: 1 });
  });
});

describe('theoddsapi probe: trying a book list offline', () => {
  it('keeps only the listed books, or every book without a list', () => {
    const events = [
      event('e', '2026-11-07T15:00:00Z', [
        { key: 'pinnacle', markets: [h2h(2, 3.5, 4)] },
        { key: 'nordicbet', markets: [h2h(2, 3.5, 4), totals(2.5)] },
      ]),
    ];
    expect(onlyBooks(events, ['pinnacle'])[0]?.bookmakers.map((b) => b.key)).toEqual(['pinnacle']);
    expect(onlyBooks(events, undefined)).toBe(events);
    expect(
      analyseOdds(onlyBooks(events, ['pinnacle', 'betsson']), NOW, ['pinnacle', 'betsson'])
        .missingBooks,
    ).toEqual(['betsson']);
  });
});

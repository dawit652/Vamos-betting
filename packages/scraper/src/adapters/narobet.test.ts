import { describe, expect, it } from 'vitest';
import { parseMrzMatches } from './narobet';

/** One match as mr-z's /api/matches serves it (markets=all), synthetic prices. */
const match = (overrides: Record<string, unknown> = {}) => ({
  id: 'cm-abc',
  api_id: 1631645,
  league_api_id: 39,
  sport: 'football',
  country: 'England',
  league: 'Premier League',
  hom: 'Arsenal',
  awy: 'Chelsea',
  schedule: '2026-11-22T16:30:00.000Z',
  status: 'SCHEDULED',
  detail_at: '2026-11-21T10:00:00.000Z',
  last_seen_at: '2026-11-21T10:05:00.000Z',
  past_kickoff: false,
  odds_stale: false,
  markets: {
    '1X2': { HOME: 1.85, DRAW: 3.6, AWAY: 4.2 },
    DOUBLE_CHANCE: { HOME_DRAW: 1.22, HOME_AWAY: 1.3, DRAW_AWAY: 1.9 },
    OVER_UNDER: {
      'OVER_2.5': 1.8,
      'UNDER_2.5': 2.0,
      'OVER_1.5': 1.25,
      'UNDER_1.5': 3.8,
      'OVER_3.5': 3.1,
    },
    BTTS: { YES: 1.7, NO: 2.05 },
    DRAW_NO_BET: { HOME: 1.35, AWAY: 3.1 },
    FIRST_HALF_WINNER: { HOME: 2.4, DRAW: 2.1, AWAY: 4.8 },
    EXACT_SCORE: { '1:0': 7.5 },
  },
  ...overrides,
});

describe('mr-z matches (Narobet board)', () => {
  it('maps the supported markets onto Vamos types, complete books only, in display order', () => {
    const list = parseMrzMatches(JSON.stringify([match()]));
    expect(list?.rejected).toBe(0);
    const [m] = list!.matches;
    expect(m).toMatchObject({
      id: 'cm-abc',
      apiId: 1631645,
      leagueApiId: 39,
      league: 'Premier League',
      country: 'England',
      home: 'Arsenal',
      away: 'Chelsea',
      pastKickoff: false,
    });
    expect(m!.kickoff.toISOString()).toBe('2026-11-22T16:30:00.000Z');
    expect(m!.pricesAt?.toISOString()).toBe('2026-11-21T10:00:00.000Z');
    expect(m!.markets).toEqual([
      {
        type: '1x2',
        line: null,
        prices: [
          { code: '1', priceMilli: 1850 },
          { code: 'X', priceMilli: 3600 },
          { code: '2', priceMilli: 4200 },
        ],
      },
      {
        type: 'ht_1x2',
        line: null,
        prices: [
          { code: '1', priceMilli: 2400 },
          { code: 'X', priceMilli: 2100 },
          { code: '2', priceMilli: 4800 },
        ],
      },
      {
        type: 'dc',
        line: null,
        prices: [
          { code: '1X', priceMilli: 1220 },
          { code: '12', priceMilli: 1300 },
          { code: 'X2', priceMilli: 1900 },
        ],
      },
      {
        type: 'btts',
        line: null,
        prices: [
          { code: 'yes', priceMilli: 1700 },
          { code: 'no', priceMilli: 2050 },
        ],
      },
      {
        type: 'dnb',
        line: null,
        prices: [
          { code: '1', priceMilli: 1350 },
          { code: '2', priceMilli: 3100 },
        ],
      },
      {
        type: 'ou',
        line: '1.5',
        prices: [
          { code: 'over', priceMilli: 1250 },
          { code: 'under', priceMilli: 3800 },
        ],
      },
      {
        type: 'ou',
        line: '2.5',
        prices: [
          { code: 'over', priceMilli: 1800 },
          { code: 'under', priceMilli: 2000 },
        ],
      },
    ]);
    // OVER_3.5 has no UNDER_3.5: that line is dropped (EXACT_SCORE is simply not read).
    expect(m!.dropped).toBe(1);
  });

  it('drops an incomplete or unpriceable book, and reads a match never detailed as no markets', () => {
    const [m] = parseMrzMatches(
      JSON.stringify([
        match({
          detail_at: null,
          markets: { '1X2': { HOME: 1.85, DRAW: 3.6 }, BTTS: { YES: 'n/a', NO: 2.05 } },
        }),
      ]),
    )!.matches;
    expect(m!.markets).toEqual([]);
    expect(m!.dropped).toBe(2);
    expect(m!.pricesAt).toBeNull();
    const [bare] = parseMrzMatches(JSON.stringify([match({ markets: {} })]))!.matches;
    expect(bare!.markets).toEqual([]);
    expect(bare!.dropped).toBe(0);
  });

  it('keeps mr-z’s past-kickoff flag and rejects entries that are not matches', () => {
    const list = parseMrzMatches(
      JSON.stringify([
        match({ past_kickoff: true }),
        match({ hom: '' }),
        match({ hom: 'Arsenal', awy: 'Arsenal' }),
        match({ schedule: 'tomorrow' }),
        42,
      ]),
    )!;
    expect(list.matches).toHaveLength(1);
    expect(list.matches[0]!.pastKickoff).toBe(true);
    expect(list.rejected).toBe(4);
  });

  it('answers null for a document that is not a list of matches', () => {
    expect(parseMrzMatches('not json')).toBeNull();
    expect(parseMrzMatches(JSON.stringify({ error: 'boom' }))).toBeNull();
    expect(parseMrzMatches(JSON.stringify([]))).toEqual({ matches: [], rejected: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { pricingMargins, priceEvent } from '../consensus/price';
import basketballOdds from './fixtures/odds-basketball.json';
import soccerOdds from './fixtures/odds-soccer.json';
import { enabledByDefault, knownSportKeys, leagueFor, slugify } from './leagues';
import { eventConsensus, eventQuotes } from './map';
import { parseEvents, type OddsApiEvent, type OddsApiSport } from './schema';

const sport = (key: string, group: string, title: string, hasOutrights = false): OddsApiSport => ({
  key,
  group,
  title,
  description: '',
  active: true,
  hasOutrights,
});

const firstEvent = (raw: unknown): OddsApiEvent => {
  const [event] = parseEvents(raw).items;
  if (event === undefined) throw new Error('fixture has no event');
  return event;
};

describe('leagueFor', () => {
  it('maps known keys onto the seeded catalogue', () => {
    expect(leagueFor(sport('soccer_epl', 'Soccer', 'EPL'))).toMatchObject({
      sport: 'football',
      category: { slug: 'england', countryCode: 'GB-ENG' },
      competition: { slug: 'premier-league', featured: true },
      tier: 1,
      cup: false,
    });
    expect(leagueFor(sport('basketball_nba', 'Basketball', 'NBA'))?.competition.slug).toBe('nba');
    expect(
      leagueFor(sport('soccer_uefa_champs_league', 'Soccer', 'UEFA Champions League'))?.cup,
    ).toBe(true);
  });

  it('skips outrights and the sports not supported yet', () => {
    expect(leagueFor(sport('soccer_epl_winner', 'Soccer', 'EPL Winner', true))).toBeNull();
    expect(
      leagueFor(sport('soccer_fifa_world_cup_winner', 'Soccer', 'World Cup Winner')),
    ).toBeNull();
    expect(leagueFor(sport('icehockey_nhl', 'Ice Hockey', 'NHL'))).toBeNull();
    expect(
      leagueFor(sport('politics_us_presidential_election_winner', 'Politics', 'US Election', true)),
    ).toBeNull();
  });

  it('gives every tennis tournament its own competition under ATP or WTA', () => {
    expect(
      leagueFor(sport('tennis_atp_paris_masters', 'Tennis', 'ATP Paris Masters')),
    ).toMatchObject({
      category: { slug: 'atp' },
      competition: {
        slug: 'atp-paris-masters',
        name: { en: 'ATP Paris Masters' },
        featured: false,
      },
      // Off by default: the credits go to football; grand slams stay on.
      tier: 2,
    });
    expect(leagueFor(sport('tennis_atp_us_open', 'Tennis', 'ATP US Open'))?.tier).toBe(1);
    expect(
      leagueFor(sport('tennis_wta_wimbledon', 'Tennis', 'WTA Wimbledon'))?.competition,
    ).toMatchObject({
      slug: 'wta-wimbledon',
      featured: true,
    });
  });

  it('derives a place for unknown keys and leaves them off', () => {
    const sweden = leagueFor(sport('soccer_sweden_allsvenskan', 'Soccer', 'Allsvenskan - Sweden'));
    expect(sweden).toMatchObject({
      category: { slug: 'sweden', name: { en: 'Sweden' } },
      competition: { slug: 'sweden-allsvenskan', name: { en: 'Allsvenskan' } },
      tier: 3,
      cup: false,
    });
    const copa = leagueFor(sport('soccer_spain_copa_del_rey', 'Soccer', 'Copa del Rey - Spain'));
    expect(copa?.category.slug).toBe('spain');
    expect(copa?.cup).toBe(true);
    expect(
      leagueFor(sport('soccer_club_friendlies', 'Soccer', 'Club Friendlies'))?.category.slug,
    ).toBe('international');
    if (sweden === null) throw new Error('expected a league');
    expect(enabledByDefault(sweden)).toBe(false);
    expect(enabledByDefault(sweden, ['soccer_sweden_allsvenskan'])).toBe(true);
  });

  it('keeps competition slugs unique per sport and categories consistent', () => {
    const entries = knownSportKeys().map((key) => {
      const [, group = ''] = /^([a-z]+)_/.exec(key) ?? [];
      const entry = leagueFor(sport(key, group === 'soccer' ? 'Soccer' : 'Basketball', key));
      if (entry === null) throw new Error(`no entry for ${key}`);
      return entry;
    });
    const slugs = entries.map((e) => `${e.sport}/${e.competition.slug}`);
    expect(new Set(slugs).size).toBe(slugs.length);
    const categories = new Map<string, string>();
    for (const entry of entries) {
      const key = `${entry.sport}/${entry.category.slug}`;
      const value = JSON.stringify(entry.category);
      expect(categories.get(key) ?? value).toBe(value);
      categories.set(key, value);
    }
    expect(slugify('Süper Lig')).toBe('super-lig');
  });
});

describe('eventQuotes and eventConsensus', () => {
  const notBefore = new Date('2026-01-01T00:00:00Z');

  it('reads the result in our selection order and totals by line', () => {
    const event = firstEvent(soccerOdds);
    const quotes = eventQuotes(event, 'football');
    expect(quotes.result.length).toBeGreaterThanOrEqual(3);
    const pinnacle = quotes.result.find((q) => q.bookmaker === 'pinnacle');
    expect(pinnacle?.prices).toEqual([1.78, 3.95, 4.72]);
    expect(quotes.totals.every((q) => q.prices.length === 2)).toBe(true);
  });

  it('prices a real fixture below the sharp book, with every football market', () => {
    const event = firstEvent(soccerOdds);
    const detail = eventConsensus(event, 'football', { notBefore });
    expect(detail.result?.ok).toBe(true);
    expect(detail.consensus.totals.map((t) => t.line)).toContain(2.5);
    const priced = priceEvent(detail.consensus, { margins: pricingMargins(), derived: true });
    const result = priced.markets.find((m) => m.type === '1x2');
    const home = result?.selections.find((s) => s.code === '1')?.oddsMilli ?? 0;
    expect(home).toBeGreaterThan(1500);
    expect(home).toBeLessThan(1780);
    expect(priced.markets.map((m) => m.type)).toEqual(
      expect.arrayContaining(['1x2', 'dc', 'dnb', 'ou', 'btts', 'cs']),
    );
  });

  it('reads two-way results for basketball', () => {
    const event = firstEvent(basketballOdds);
    const detail = eventConsensus(event, 'basketball', { notBefore });
    expect(detail.consensus.result).toHaveLength(2);
    const priced = priceEvent(detail.consensus, { margins: pricingMargins(), derived: true });
    expect(priced.markets.map((m) => m.type)).toEqual(['ml', 'total']);
  });

  it('ignores outcomes it cannot place and outright events', () => {
    const at = new Date('2026-11-07T10:00:00Z');
    const base: OddsApiEvent = {
      id: 'x',
      sportKey: 'soccer_epl',
      sportTitle: 'EPL',
      commenceTime: new Date('2026-11-08T15:00:00Z'),
      homeTeam: 'Arsenal',
      awayTeam: 'Chelsea',
      bookmakers: [
        {
          key: 'pinnacle',
          title: 'Pinnacle',
          lastUpdate: at,
          markets: [
            {
              key: 'h2h',
              lastUpdate: at,
              outcomes: [
                { name: 'Arsenal', price: 1.8, point: null, description: null },
                { name: 'Chelsea', price: 2.1, point: null, description: null },
              ],
            },
            {
              key: 'totals',
              lastUpdate: at,
              outcomes: [
                { name: 'Over', price: 1.9, point: 2.5, description: null },
                { name: 'Under', price: 1.9, point: 3.5, description: null },
              ],
            },
          ],
        },
      ],
    };
    expect(eventQuotes(base, 'football')).toEqual({ result: [], totals: [] });
    expect(eventQuotes({ ...base, homeTeam: null, awayTeam: null }, 'basketball').result).toEqual(
      [],
    );
    const renamed = eventQuotes({ ...base, homeTeam: ' arsenal ' }, 'basketball');
    expect(renamed.result[0]?.prices).toEqual([1.8, 2.1]);
  });
});

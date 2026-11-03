import { describe, expect, it, vi } from 'vitest';
import { fairProbabilities } from '../consensus/devig';
import { bothScoreProbability, overProbability, scoreGrid } from '../consensus/goals-model';
import { priceEvent, pricingMargins } from '../consensus/price';
import { OddsApiClient, OddsApiError } from './client';
import errors from './fixtures/real-errors.json';
import eplEventOdds from './fixtures/real-epl-event-odds.json';
import eplEvents from './fixtures/real-epl-events.json';
import eplOdds from './fixtures/real-epl-odds.json';
import eplScores from './fixtures/real-epl-scores.json';
import nbaOdds from './fixtures/real-nba-odds.json';
import nbaScores from './fixtures/real-nba-scores.json';
import realSports from './fixtures/real-sports.json';
import tennisOdds from './fixtures/real-tennis-odds.json';
import tennisScores from './fixtures/real-tennis-scores.json';
import uclOdds from './fixtures/real-ucl-odds.json';
import { enabledByDefault, knownSportKeys, leagueFor } from './leagues';
import { eventConsensus } from './map';
import {
  parseErrorBody,
  parseEvent,
  parseEvents,
  parseScores,
  parseSports,
  type OddsApiEvent,
} from './schema';

/**
 * Real responses captured from The Odds API on 3 Nov 2026 at about 15:13 UTC (region eu), see
 * fixtures/README.md. They pin down what the hand-made fixtures only assumed.
 */

/** A little before the capture: every bookmaker stamp in the fixtures is newer than this. */
const NOT_BEFORE = new Date('2026-11-03T14:40:00Z');

function eventsOf(raw: unknown): OddsApiEvent[] {
  const parsed = parseEvents(raw);
  expect(parsed.dropped).toBe(0);
  return parsed.items;
}

describe('the sports list', () => {
  const sports = parseSports(realSports);

  it('parses all 184 keys', () => {
    expect(sports.dropped).toBe(0);
    expect(sports.items).toHaveLength(184);
  });

  it('knows no sport key the API lacks', () => {
    const real = new Set(sports.items.map((sport) => sport.key));
    expect(knownSportKeys().filter((key) => !real.has(key))).toEqual([]);
  });

  it('places every football, basketball and tennis key, and skips outrights and other sports', () => {
    for (const sport of sports.items) {
      const entry = leagueFor(sport);
      const supported = ['Soccer', 'Basketball', 'Tennis'].includes(sport.group);
      if (supported && !sport.hasOutrights) {
        expect(entry, sport.key).not.toBeNull();
      } else {
        expect(entry, sport.key).toBeNull();
      }
    }
    const placed = sports.items.flatMap((sport) => leagueFor(sport) ?? []);
    expect(placed.filter((e) => e.sport === 'football').length).toBeGreaterThan(60);
    // Competition slugs are unique per sport, whatever the key.
    const slugs = placed.map((e) => `${e.sport}/${e.competition.slug}`);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('finds the country of keys the registry does not list', () => {
    const category = (key: string): string | undefined =>
      leagueFor(sports.items.find((sport) => sport.key === key)!)?.category.slug;
    expect(category('soccer_germany_dfb_pokal')).toBe('germany');
    expect(category('soccer_spain_copa_del_rey')).toBe('spain');
    expect(category('soccer_league_of_ireland')).toBe('ireland');
    expect(category('soccer_korea_kleague1')).toBe('korea');
    expect(category('soccer_denmark_superliga')).toBe('denmark');
    expect(category('basketball_wncaab')).toBe('usa');
    expect(category('soccer_conmebol_copa_sudamericana')).toBe('international');
  });

  it('does not cover the Ethiopian Premier League, CAF competitions or volleyball', () => {
    const text = sports.items
      .map((sport) => `${sport.key} ${sport.title}`.toLowerCase())
      .join('\n');
    expect(text).not.toMatch(/ethiop|\bcaf\b|_caf_|volleyball/);
  });

  it('turns on tier 1 leagues, or exactly the listed keys', () => {
    const epl = leagueFor(sports.items.find((sport) => sport.key === 'soccer_epl')!)!;
    const sweden = leagueFor(
      sports.items.find((sport) => sport.key === 'soccer_sweden_allsvenskan')!,
    )!;
    expect(enabledByDefault(epl)).toBe(true);
    expect(enabledByDefault(sweden)).toBe(false);
    expect(enabledByDefault(sweden, ['soccer_sweden_allsvenskan'])).toBe(true);
    expect(enabledByDefault(epl, ['soccer_sweden_allsvenskan'])).toBe(false);
  });
});

describe('real odds', () => {
  it('parse without drops, bookmakers carrying their own last_update', () => {
    for (const raw of [eplOdds, uclOdds, nbaOdds, tennisOdds]) {
      for (const event of eventsOf(raw)) {
        expect(event.homeTeam).not.toBeNull();
        expect(event.bookmakers.length).toBeGreaterThanOrEqual(5);
        for (const bookmaker of event.bookmakers) {
          expect(bookmaker.lastUpdate.getTime()).toBeGreaterThan(NOT_BEFORE.getTime());
        }
      }
    }
    expect(eventsOf(eplEvents)[0]?.bookmakers).toEqual([]);
  });

  it('parse the per-event endpoint, whose bookmakers have no last_update of their own', () => {
    const parsed = parseEvent(eplEventOdds);
    expect(parsed.dropped).toBe(0);
    const books = parsed.items[0]!.bookmakers;
    expect(books.map((b) => b.key)).toEqual(['winamax_fr', 'onexbet', 'winamax_de', 'unibet_fr']);
    const onexbet = books.find((b) => b.key === 'onexbet')!;
    expect(onexbet.lastUpdate).toEqual(new Date('2026-11-03T15:12:49Z'));
    const alternate = onexbet.markets.find((m) => m.key === 'alternate_totals')!;
    // Lines quoted at exactly 1.00 are dead lines and are skipped, not counted as malformed.
    expect(alternate.outcomes.every((o) => o.price > 1)).toBe(true);
    expect(alternate.outcomes.length).toBe(24);
  });

  it('give a consensus for every h2h market, with the books in close agreement', () => {
    const sets = [
      [eplOdds, 'football'],
      [uclOdds, 'football'],
      [nbaOdds, 'basketball'],
      [tennisOdds, 'tennis'],
    ] as const;
    for (const [raw, sport] of sets) {
      for (const event of eventsOf(raw)) {
        const { result } = eventConsensus(event, sport, { notBefore: NOT_BEFORE, minBooks: 2 });
        expect(result?.ok, `${event.homeTeam} v ${event.awayTeam}`).toBe(true);
        if (result?.ok !== true) continue;
        expect(result.books.length).toBeGreaterThanOrEqual(5);
        expect(result.disagreement).toBeLessThan(0.04);
        expect(result.excluded.outliers).toEqual([]);
      }
    }
  });

  it('price below the market, inside the range the books quote', () => {
    const [everton] = eventsOf(eplOdds);
    const detail = eventConsensus(everton!, 'football', { notBefore: NOT_BEFORE, minBooks: 2 });
    const priced = priceEvent(detail.consensus, { margins: pricingMargins(), derived: true });
    const market = priced.markets.find((m) => m.type === '1x2')!;
    const probabilities = detail.consensus.result!;
    market.selections.forEach((selection, i) => {
      expect(1000 / selection.oddsMilli).toBeGreaterThanOrEqual(probabilities[i]!);
    });
    const home = market.selections.find((s) => s.code === '1')!.oddsMilli;
    // The books quote Everton between 1.60 and 1.78.
    expect(home).toBeGreaterThan(1550);
    expect(home).toBeLessThan(1780);
  });

  it('withhold the model markets when a match has no total from enough books', () => {
    const [shakhtar] = eventsOf(uclOdds);
    const detail = eventConsensus(shakhtar!, 'football', { notBefore: NOT_BEFORE, minBooks: 2 });
    const priced = priceEvent(detail.consensus, { margins: pricingMargins(), derived: true });
    expect(priced.markets.map((m) => m.type)).toEqual(['1x2', 'dc', 'dnb']);
  });

  it('read basketball on the line most books quote, and drop whole-point lines', () => {
    const [pistons] = eventsOf(nbaOdds);
    const detail = eventConsensus(pistons!, 'basketball', { notBefore: NOT_BEFORE, minBooks: 2 });
    expect(detail.consensus.totals.map((t) => t.line)).toEqual([218.5]);
    const priced = priceEvent(detail.consensus, { margins: pricingMargins(), derived: true });
    expect(priced.markets.map((m) => `${m.type}:${m.line ?? ''}`)).toEqual(['ml:', 'total:218.5']);
  });
});

describe('the goals model against a real bookmaker', () => {
  it('stays within 3 points of 1xBet alternate totals and both-teams-to-score', () => {
    const [everton] = eventsOf(eplOdds);
    const detail = eventConsensus(everton!, 'football', { notBefore: NOT_BEFORE, minBooks: 2 });
    const priced = priceEvent(detail.consensus, { margins: pricingMargins(), derived: true });
    expect(priced.derived).toBe(true);
    const grid = scoreGrid(priced.fit!);

    const onexbet = parseEvent(eplEventOdds).items[0]!.bookmakers.find((b) => b.key === 'onexbet')!;
    const totals = onexbet.markets.find((m) => m.key === 'alternate_totals')!.outcomes;
    for (const line of [1.5, 2.5, 3.5, 4.5]) {
      const price = (side: string): number =>
        totals.find((o) => o.name === side && o.point === line)!.price;
      const market = fairProbabilities([price('Over'), price('Under')])[0]!;
      expect(Math.abs(overProbability(grid, line) - market), `over ${line}`).toBeLessThan(0.03);
    }
    const btts = onexbet.markets.find((m) => m.key === 'btts')!.outcomes;
    const yes = btts.find((o) => o.name === 'Yes')!.price;
    const no = btts.find((o) => o.name === 'No')!.price;
    expect(Math.abs(bothScoreProbability(grid) - fairProbabilities([yes, no])[0]!)).toBeLessThan(
      0.03,
    );
  });
});

describe('real scores', () => {
  it('parse completed, upcoming and (for tennis) unscored matches', () => {
    const epl = parseScores(eplScores);
    expect(epl.dropped).toBe(0);
    expect(epl.items.filter((s) => s.completed)).toHaveLength(3);
    const liverpool = epl.items.find((s) => s.homeTeam === 'Liverpool')!;
    expect(liverpool.scores).toEqual([
      { name: 'Liverpool', score: '0' },
      { name: 'Arsenal', score: '1' },
    ]);
    const upcoming = epl.items.find((s) => !s.completed)!;
    expect(upcoming.scores).toBeNull();
    expect(upcoming.lastUpdate).not.toBeNull();
    expect(parseScores(nbaScores).items.filter((s) => s.completed)).toHaveLength(3);
    // A tennis match already under way (its odds are live) still shows no score.
    const tennis = parseScores(tennisScores).items[0]!;
    expect(tennis.completed).toBe(false);
    expect(tennis.scores).toBeNull();
    expect(tennis.commenceTime.getTime()).toBeLessThan(new Date('2026-11-03T15:13:00Z').getTime());
  });
});

describe('real error responses', () => {
  const respond = (status: number, body: unknown) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    const client = new OddsApiClient({ apiKey: 'k'.repeat(32), fetch, retries: 0 });
    return client.odds('soccer_epl', { markets: ['h2h'], regions: ['eu'] });
  };

  it('parse the error body format', () => {
    expect(parseErrorBody(errors.invalidKey)).toEqual({
      message: errors.invalidKey.message,
      errorCode: 'INVALID_KEY',
    });
  });

  it('become the right error kinds', async () => {
    await expect(respond(401, errors.invalidKey)).rejects.toMatchObject({
      kind: 'auth',
      code: 'INVALID_KEY',
    });
    await expect(respond(422, errors.invalidMarket)).rejects.toMatchObject({
      kind: 'invalid_request',
      code: 'INVALID_MARKET',
    });
    await expect(respond(404, errors.unknownSport)).rejects.toMatchObject({
      kind: 'not_found',
      code: 'UNKNOWN_SPORT',
    });
    await expect(respond(401, errors.invalidKey)).rejects.toBeInstanceOf(OddsApiError);
  });
});

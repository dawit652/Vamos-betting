import { describe, expect, it } from 'vitest';
import { pricingMargins, priceEvent } from '../consensus/price';
import type { FeedMarket } from '../types';
import { OddsApiClient, OddsApiError, estimateOddsCost, estimateScoresCost } from './client';
import errors from './fixtures/real/errors.json';
import eventOddsEpl from './fixtures/real/event-odds-epl.json';
import oddsEpl from './fixtures/real/odds-epl.json';
import oddsNba from './fixtures/real/odds-nba.json';
import oddsTennis from './fixtures/real/odds-tennis.json';
import oddsUcl from './fixtures/real/odds-ucl.json';
import quota from './fixtures/real/quota.json';
import scoresEpl from './fixtures/real/scores-epl.json';
import scoresNba from './fixtures/real/scores-nba.json';
import scoresTennis from './fixtures/real/scores-tennis.json';
import scoresUcl from './fixtures/real/scores-ucl.json';
import sports from './fixtures/real/sports.json';
import { knownSportKeys, leagueFor } from './leagues';
import { eventConsensus, eventQuotes } from './map';
import {
  parseErrorBody,
  parseEvent,
  parseEvents,
  parseScores,
  parseSports,
  type OddsApiEvent,
} from './schema';

/**
 * Tests against REAL Odds API v4 responses (eu region, captured 2026-11-03,
 * see fixtures/real/README.md). They pin what the real service does, so a
 * parser or mapping change that breaks on real data fails here.
 */

const notBefore = new Date('2026-11-03T14:00:00Z');

function eventOf(raw: unknown, home: string, away: string): OddsApiEvent {
  const found = parseEvents(raw).items.find((e) => e.homeTeam === home && e.awayTeam === away);
  if (found === undefined) throw new Error(`no event ${home} v ${away}`);
  return found;
}

/** The odds of a market's selections as integer milli odds, by selection code. */
function milli(market: FeedMarket | undefined): Record<string, number> {
  return Object.fromEntries((market?.selections ?? []).map((s) => [s.code, Number(s.oddsMilli)]));
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

describe('/sports', () => {
  const parsed = parseSports(sports);

  it('parses all 184 sports without drops', () => {
    expect(parsed.items).toHaveLength(184);
    expect(parsed.dropped).toBe(0);
    expect(parsed.items.filter((s) => s.active)).toHaveLength(80);
    expect(parsed.items.filter((s) => s.hasOutrights)).toHaveLength(12);
  });
});

describe('odds endpoints', () => {
  it.each([
    ['epl', oddsEpl],
    ['ucl', oddsUcl],
    ['nba', oddsNba],
    ['tennis', oddsTennis],
  ])('parses %s: 2 events, nothing dropped', (_name, raw) => {
    const { items, dropped } = parseEvents(raw);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(2);
  });
});

describe('/events/{id}/odds', () => {
  // With the old schema every bookmaker here was dropped: the per-event
  // endpoint gives bookmakers no last_update, and 1xBet quotes some prices at 1.0.
  const { items, dropped } = parseEvent(eventOddsEpl);
  const [event] = items;

  it('keeps the 4 bookmakers although they have no last_update', () => {
    expect(items).toHaveLength(1);
    expect(dropped).toBe(0);
    expect(event!.bookmakers).toHaveLength(4);
  });

  it("gives each bookmaker the newest of its markets' times", () => {
    for (const book of event!.bookmakers) {
      const times = book.markets.map((m) => m.lastUpdate.getTime());
      expect(times.length).toBeGreaterThan(0);
      expect(book.lastUpdate.getTime()).toBe(Math.max(...times));
    }
  });

  it('leaves out the 1.0 outcomes of 1xBet alternate_totals (26 raw, 24 kept)', () => {
    const raw = eventOddsEpl.bookmakers
      .find((b) => b.key === 'onexbet')!
      .markets.find((m) => m.key === 'alternate_totals')!;
    expect(raw.outcomes).toHaveLength(26);
    expect(raw.outcomes.filter((o) => o.price === 1)).toHaveLength(2);
    const kept = event!.bookmakers
      .find((b) => b.key === 'onexbet')!
      .markets.find((m) => m.key === 'alternate_totals')!;
    expect(kept.outcomes).toHaveLength(24);
    expect(kept.outcomes.every((o) => o.price > 1)).toBe(true);
  });
});

describe('mapping: EPL Everton v Coventry City', () => {
  const event = eventOf(oddsEpl, 'Everton', 'Coventry City');

  it('reorders the API outcomes (Coventry, Everton, Draw) to [home, draw, away]', () => {
    const { result } = eventQuotes(event, 'football');
    expect(result.find((q) => q.bookmaker === 'onexbet')?.prices).toEqual([1.75, 4.16, 4.93]);
  });

  it('takes only h2h from an exchange, never its h2h_lay', () => {
    const book = event.bookmakers.find((b) => b.key === 'betfair_ex_eu')!;
    expect(book.markets.map((m) => m.key)).toEqual(['h2h', 'h2h_lay']);
    const { result } = eventQuotes(event, 'football');
    expect(result.filter((q) => q.bookmaker === 'betfair_ex_eu')).toHaveLength(1);
    expect(result.find((q) => q.bookmaker === 'betfair_ex_eu')?.prices).toEqual([1.78, 4, 5]);
    expect(result).toHaveLength(8);
  });

  it('quotes totals at 2.5 from onexbet and mybookieag', () => {
    const { totals } = eventQuotes(event, 'football');
    expect(totals.map((q) => [q.bookmaker, q.line, q.prices])).toEqual([
      ['onexbet', 2.5, [1.81, 2.15]],
      ['mybookieag', 2.5, [1.68, 2.07]],
    ]);
  });

  it('builds a consensus for the result and the 2.5 line', () => {
    const detail = eventConsensus(event, 'football', { notBefore, minBooks: 2 });
    expect(detail.result?.ok).toBe(true);
    const [home = 0, draw = 0, away = 0] = detail.consensus.result ?? [];
    expect(home + draw + away).toBeCloseTo(1, 9);
    // Books price the home side at about 1.6 to 1.78 (62% to 56%) before margin.
    expect(home).toBeGreaterThan(0.5);
    expect(home).toBeLessThan(0.62);
    expect(detail.consensus.totals).toHaveLength(1);
    expect(detail.consensus.totals[0]).toMatchObject({ line: 2.5, books: 2 });
  });
});

describe('mapping: UCL', () => {
  it('does not use a whole line: Coolbet totals at 3.0 make no consensus', () => {
    const event = eventOf(oddsUcl, 'Shakhtar Donetsk', 'Sporting Lisbon');
    const { totals } = eventQuotes(event, 'football');
    expect(totals.find((q) => q.bookmaker === 'coolbet')?.line).toBe(3);
    const detail = eventConsensus(event, 'football', { notBefore });
    expect(detail.totals.map((t) => t.line)).toEqual([2.5]);
    expect(detail.consensus.totals.map((t) => t.line)).not.toContain(3);
  });

  it('builds a 2-book consensus for Galatasaray v VfB Stuttgart at 3.5', () => {
    const event = eventOf(oddsUcl, 'Galatasaray', 'VfB Stuttgart');
    const detail = eventConsensus(event, 'football', { notBefore, minBooks: 2 });
    expect(detail.consensus.totals).toHaveLength(1);
    expect(detail.consensus.totals[0]).toMatchObject({ line: 3.5, books: 2 });
    expect(eventQuotes(event, 'football').totals.map((q) => q.bookmaker)).toEqual([
      'onexbet',
      'marathonbet',
    ]);
  });
});

describe('mapping and pricing: NBA Detroit Pistons v Philadelphia 76ers', () => {
  const event = eventOf(oddsNba, 'Detroit Pistons', 'Philadelphia 76ers');
  const detail = eventConsensus(event, 'basketball', { notBefore, minBooks: 2 });

  it('reads a 2-way result and ignores the 219.0 total of Coolbet', () => {
    expect(eventQuotes(event, 'basketball').result.every((q) => q.prices.length === 2)).toBe(true);
    expect(detail.consensus.result).toHaveLength(2);
    const lines = detail.consensus.totals.map((t) => t.line);
    expect(lines).toEqual([218.5]);
    expect(detail.consensus.totals[0]!.books).toBe(4);
  });

  it('prices ml and total 218.5 with a margin on every market', () => {
    const priced = priceEvent(detail.consensus, { margins: pricingMargins(), derived: true });
    expect(priced.markets.map((m) => m.type)).toEqual(['ml', 'total']);
    expect(priced.markets[1]!.line).toBe('218.5');
    for (const market of priced.markets) {
      const prices = market.selections.map((s) => Number(s.oddsMilli));
      expect(prices.every((p) => Number.isInteger(p) && p > 1000)).toBe(true);
      // We keep a margin: implied probabilities add up to more than 1.
      expect(sum(prices.map((p) => 1000 / p))).toBeGreaterThan(1);
    }
    expect(Object.keys(milli(priced.markets[0]))).toHaveLength(2);
  });
});

describe('mapping: tennis', () => {
  const event = eventOf(oddsTennis, 'Brandon Nakashima', 'Matteo Berrettini');

  it('reads a 2-way h2h and no totals (tennis uses h2h only)', () => {
    const quotes = eventQuotes(event, 'tennis');
    expect(event.sportKey).toBe('tennis_atp_paris_masters');
    expect(quotes.result).toHaveLength(6);
    expect(quotes.result.every((q) => q.prices.length === 2)).toBe(true);
    expect(quotes.totals).toEqual([]);
  });
});

describe('/scores', () => {
  it.each([
    ['epl', scoresEpl],
    ['ucl', scoresUcl],
    ['nba', scoresNba],
    ['tennis', scoresTennis],
  ])('parses %s without drops', (_name, raw) => {
    expect(parseScores(raw).dropped).toBe(0);
  });

  it('has completed EPL games with string scores and Everton v Coventry not started', () => {
    const { items } = parseScores(scoresEpl);
    const completed = items.filter((s) => s.completed);
    expect(completed).toHaveLength(3);
    for (const s of completed) {
      expect(s.scores).toHaveLength(2);
      expect(s.scores!.every((x) => typeof x.score === 'string')).toBe(true);
    }
    const everton = items.find((s) => s.homeTeam === 'Everton')!;
    expect(everton.completed).toBe(false);
    expect(everton.scores).toBeNull();
  });

  it('returns no tennis scores: the worker must not rely on them', () => {
    const [entry] = parseScores(scoresTennis).items;
    expect(entry).toMatchObject({ completed: false, scores: null, lastUpdate: null });
  });
});

describe('errors', () => {
  it('reads the error codes of the real bodies', () => {
    expect(parseErrorBody(errors.invalidMarket.body)?.errorCode).toBe('INVALID_MARKET');
    expect(parseErrorBody(errors.unknownSport.body)?.errorCode).toBe('UNKNOWN_SPORT');
  });

  const KEY = 'sekret-KEY_123';
  const failing = async (sample: { status: number; body: unknown }): Promise<OddsApiError> => {
    const client = new OddsApiClient({
      apiKey: KEY,
      retries: 0,
      fetch: async () => new Response(JSON.stringify(sample.body), { status: sample.status }),
    });
    try {
      await client.odds('soccer_epl', { markets: ['btts'], regions: ['eu'] });
    } catch (error) {
      expect(error).toBeInstanceOf(OddsApiError);
      return error as OddsApiError;
    }
    throw new Error('expected a rejection');
  };

  it.each([
    ['invalidMarket', errors.invalidMarket, 'invalid_request'],
    ['unknownSport', errors.unknownSport, 'not_found'],
  ] as const)('maps %s to %s without leaking the key', async (_name, sample, kind) => {
    const error = await failing(sample);
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(sample.status);
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(KEY);
    expect(error.path).not.toContain(KEY);
  });
});

describe('credits (quota.json)', () => {
  const calls = Object.entries(quota);
  const last = (name: keyof typeof quota) => quota[name].last;

  it('has used + remaining = 500 on every call', () => {
    for (const [, call] of calls) expect(call.used + call.remaining).toBe(500);
  });

  it('matches markets x regions for odds calls', () => {
    expect(estimateOddsCost({ markets: ['h2h', 'totals'], regions: ['eu'] })).toBe(2);
    expect(last('epl-odds')).toBe(2);
    const three = estimateOddsCost({ markets: ['h2h', 'totals', 'spreads'], regions: ['eu'] });
    expect(three).toBe(3);
    for (const name of ['ucl-odds', 'nba-odds', 'tennis-odds'] as const) {
      expect(last(name)).toBe(three);
    }
  });

  it('matches 2 credits for scores with daysFrom, whatever the days', () => {
    for (const days of [1, 3]) expect(estimateScoresCost(days)).toBe(2);
    for (const name of ['epl-scores', 'ucl-scores', 'nba-scores', 'tennis-scores'] as const) {
      expect(last(name)).toBe(2);
    }
  });

  it('charges nothing for /sports and /events', () => {
    expect(last('sports')).toBe(0);
    expect(last('epl-events')).toBe(0);
  });
});

describe('league registry against the real sports list', () => {
  const all = parseSports(sports).items;
  const supported = new Set(['Soccer', 'Basketball', 'Tennis']);

  it('knows only keys the API lists', () => {
    const keys = new Set(all.map((s) => s.key));
    for (const key of knownSportKeys()) expect(keys.has(key), key).toBe(true);
  });

  it('skips outrights and other groups', () => {
    for (const s of all) {
      if (s.hasOutrights || !supported.has(s.group)) expect(leagueFor(s), s.key).toBeNull();
    }
  });

  it('places every non-outright soccer, basketball and tennis sport', () => {
    for (const s of all) {
      if (!s.hasOutrights && supported.has(s.group)) expect(leagueFor(s), s.key).not.toBeNull();
    }
  });
});

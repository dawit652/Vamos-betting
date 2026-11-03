import { describe, expect, it } from 'vitest';
import basketball from './fixtures/odds-basketball.json';
import soccer from './fixtures/odds-soccer.json';
import scoresFixture from './fixtures/scores-soccer.json';
import sportsFixture from './fixtures/sports.json';
import {
  parseErrorBody,
  parseEvent,
  parseEvents,
  parseParticipants,
  parseScores,
  parseSports,
} from './schema';

const market = (outcomes: unknown[], extra: object = {}) => ({ key: 'h2h', outcomes, ...extra });
const book = (markets: unknown[], extra: object = {}) => ({
  key: 'pinnacle',
  title: 'Pinnacle',
  last_update: '2026-11-03T10:00:00Z',
  markets,
  ...extra,
});
const event = (bookmakers: unknown, extra: object = {}) => ({
  id: 'ev1',
  sport_key: 'soccer_epl',
  sport_title: 'EPL',
  commence_time: '2026-11-08T15:00:00Z',
  home_team: 'A',
  away_team: 'B',
  bookmakers,
  ...extra,
});
const good = [
  { name: 'A', price: 1.9 },
  { name: 'B', price: 2.1 },
];

describe('parseSports', () => {
  it('maps the fixture to camelCase', () => {
    const { items, dropped } = parseSports(sportsFixture);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(sportsFixture.length);
    expect(items.find((s) => s.key === 'soccer_epl_winner')?.hasOutrights).toBe(true);
    expect(items.some((s) => !s.active)).toBe(true);
  });

  it('drops invalid entries and non-arrays', () => {
    expect(parseSports({ not: 'an array' })).toEqual({ items: [], dropped: 1 });
    const result = parseSports([sportsFixture[0], { key: 'x' }, null]);
    expect(result.items).toHaveLength(1);
    expect(result.dropped).toBe(2);
  });
});

describe('parseEvents', () => {
  it('parses the soccer fixture into domain objects', () => {
    const { items, dropped } = parseEvents(soccer);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(2);
    const first = items[0]!;
    expect(first.commenceTime).toEqual(new Date('2026-11-08T15:00:00Z'));
    expect(first.bookmakers).toHaveLength(5);
    const pinnacle = first.bookmakers[0]!;
    expect(pinnacle.lastUpdate).toBeInstanceOf(Date);
    const [h2h, totals] = pinnacle.markets;
    expect(h2h?.outcomes.map((o) => o.name)).toEqual(['Arsenal', 'Chelsea', 'Draw']);
    expect(h2h?.outcomes[0]?.point).toBeNull();
    expect(h2h?.outcomes[0]?.description).toBeNull();
    expect(totals?.outcomes[0]?.point).toBe(2.5);
    const marathon = items[1]!.bookmakers.find((b) => b.key === 'marathonbet');
    expect(marathon?.markets[1]?.outcomes[0]?.point).toBe(2.25);
  });

  it('parses spreads with negative and positive points', () => {
    const { items } = parseEvents(basketball);
    const spreads = items[0]!.bookmakers[0]!.markets.find((m) => m.key === 'spreads');
    expect(spreads?.outcomes.map((o) => o.point)).toEqual([-4.5, 4.5]);
  });

  it('falls back to the bookmaker last_update for a market without one', () => {
    const { items } = parseEvents([event([book([market(good)])])]);
    expect(items[0]!.bookmakers[0]!.markets[0]!.lastUpdate).toEqual(
      new Date('2026-11-03T10:00:00Z'),
    );
    const own = market(good, { last_update: '2026-11-03T10:05:00+02:00' });
    const parsed = parseEvents([event([book([own])])]);
    expect(parsed.items[0]!.bookmakers[0]!.markets[0]!.lastUpdate).toEqual(
      new Date('2026-11-03T08:05:00Z'),
    );
  });

  it('keeps an event without bookmakers and tolerates outright events', () => {
    const outright = event(undefined, { home_team: null, away_team: undefined, sport_title: null });
    const { items, dropped } = parseEvents([event([]), outright]);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ homeTeam: null, awayTeam: null, sportTitle: null });
    expect(items[1]!.bookmakers).toEqual([]);
  });

  it('drops an event with a bad commence_time and counts it', () => {
    const result = parseEvents([event([], { commence_time: 'tomorrow' }), event([])]);
    expect(result.items).toHaveLength(1);
    expect(result.dropped).toBe(1);
  });

  it('drops only the bookmaker with a bad last_update', () => {
    const bad = book([market(good)], { last_update: 'nope' });
    const result = parseEvents([event([bad, book([market(good)], { key: 'betfair' })])]);
    expect(result.items[0]!.bookmakers.map((b) => b.key)).toEqual(['betfair']);
    expect(result.dropped).toBe(1);
  });

  it('drops a market whole for a price of 0.95, a non-numeric price or no outcomes', () => {
    const cheap = market([...good, { name: 'Draw', price: 0.95 }]);
    const text = market([{ name: 'A', price: '1.9' }, good[1]]);
    const empty = market([]);
    const badPoint = market([{ name: 'A', price: 1.9, point: 'x' }]);
    const kept = { ...market(good), key: 'totals' };
    const result = parseEvents([event([book([cheap, text, empty, badPoint, kept])])]);
    expect(result.items[0]!.bookmakers[0]!.markets.map((m) => m.key)).toEqual(['totals']);
    expect(result.dropped).toBe(4);
  });

  it('counts a non-array bookmakers value as one drop and ignores unknown fields', () => {
    const result = parseEvents([event('oops', { extra: 1 })]);
    expect(result.items).toHaveLength(1);
    expect(result.dropped).toBe(1);
    expect(parseEvents('x')).toEqual({ items: [], dropped: 1 });
  });
});

describe('parseEvent', () => {
  it('parses one event object', () => {
    const result = parseEvent(event([book([market(good)])]));
    expect(result.items).toHaveLength(1);
    expect(result.dropped).toBe(0);
  });

  it('returns no item for an invalid object or an array', () => {
    expect(parseEvent({ id: 'x' })).toEqual({ items: [], dropped: 1 });
    expect(parseEvent([])).toEqual({ items: [], dropped: 1 });
  });
});

describe('parseScores', () => {
  it('parses completed, in-play and upcoming scores', () => {
    const { items, dropped } = parseScores(scoresFixture);
    expect(dropped).toBe(0);
    expect(items.map((s) => s.completed)).toEqual([true, false, false]);
    expect(items[0]!.scores).toEqual([
      { name: 'Tottenham Hotspur', score: '2' },
      { name: 'Newcastle United', score: '1' },
    ]);
    expect(items[0]!.lastUpdate).toBeInstanceOf(Date);
    expect(items[1]!.scores).toHaveLength(2);
    expect(items[2]!.scores).toBeNull();
    expect(items[2]!.lastUpdate).toBeNull();
  });

  it('drops scores whose values are not strings', () => {
    const bad = { ...scoresFixture[0], scores: [{ name: 'A', score: 2 }] };
    expect(parseScores([bad]).dropped).toBe(1);
  });
});

describe('parseParticipants and parseErrorBody', () => {
  it('maps full_name', () => {
    const result = parseParticipants([{ full_name: 'Arsenal', id: 'par_1' }, { id: 'x' }]);
    expect(result.items).toEqual([{ id: 'par_1', fullName: 'Arsenal' }]);
    expect(result.dropped).toBe(1);
  });

  it('reads the documented error body and rejects anything else', () => {
    expect(
      parseErrorBody({ message: 'bad', error_code: 'INVALID_MARKET', details_url: 'https://x' }),
    ).toEqual({ message: 'bad', errorCode: 'INVALID_MARKET' });
    expect(parseErrorBody({ message: 'bad' })).toEqual({ message: 'bad', errorCode: null });
    expect(parseErrorBody('nope')).toBeNull();
    expect(parseErrorBody(null)).toBeNull();
  });
});

describe('bookmaker without its own last_update (per-event odds endpoint)', () => {
  const noTime = { last_update: undefined };
  const early = '2026-11-03T10:00:00Z';
  const late = '2026-11-03T10:07:00Z';

  it('takes the newest market time as the bookmaker time', () => {
    const markets = [
      market(good, { last_update: early }),
      market(good, { key: 'totals', last_update: late }),
    ];
    const [parsed] = parseEvent(event([book(markets, noTime)])).items[0]!.bookmakers;
    expect(parsed!.lastUpdate).toEqual(new Date(late));
    expect(parsed!.markets.map((m) => m.lastUpdate)).toEqual([new Date(early), new Date(late)]);
  });

  it('drops a market without any time and counts it, keeping the others', () => {
    const markets = [market(good), market(good, { key: 'totals', last_update: early })];
    const result = parseEvent(event([book(markets, noTime)]));
    expect(result.dropped).toBe(1);
    const parsed = result.items[0]!.bookmakers[0]!;
    expect(parsed.markets.map((m) => m.key)).toEqual(['totals']);
    expect(parsed.lastUpdate).toEqual(new Date(early));
  });

  it('drops the bookmaker when no market has a time', () => {
    const result = parseEvent(event([book([market(good)], noTime)]));
    expect(result.items[0]!.bookmakers).toEqual([]);
    expect(result.dropped).toBe(1);
  });
});

describe('a price of exactly 1.0 (no price)', () => {
  const withNoPrice = [...good, { name: 'Draw', price: 1.0 }];

  it('leaves the outcome out silently and keeps the market', () => {
    const result = parseEvent(event([book([market(withNoPrice)])]));
    expect(result.dropped).toBe(0);
    const kept = result.items[0]!.bookmakers[0]!.markets;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.outcomes.map((o) => o.name)).toEqual(['A', 'B']);
  });

  it('makes a market of only 1.0 prices disappear without a drop', () => {
    const onlyNoPrice = market([
      { name: 'A', price: 1 },
      { name: 'B', price: 1 },
    ]);
    const result = parseEvent(event([book([onlyNoPrice, { ...market(good), key: 'totals' }])]));
    expect(result.dropped).toBe(0);
    expect(result.items[0]!.bookmakers[0]!.markets.map((m) => m.key)).toEqual(['totals']);
  });

  it('still drops the whole market and counts it for a price below 1', () => {
    const result = parseEvent(event([book([market([...good, { name: 'Draw', price: 0.95 }])])]));
    expect(result.items[0]!.bookmakers[0]!.markets).toEqual([]);
    expect(result.dropped).toBe(1);
  });
});

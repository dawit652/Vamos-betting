import { readFileSync } from 'node:fs';
import { americanToOddsMilli, isValidAmericanOdds } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RawDocument } from '../types';
import { createAdapter } from './registry';
import {
  TherundownConfigSchema,
  parseTherundownEvents,
  therundownAffiliatesUrl,
  therundownDayUrl,
  therundownEventUrl,
  therundownScoresUrl,
  utcDateOf,
} from './therundown';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
const day = fixture('therundown-day.json');
const T = '2026-10-31T10:00:00Z';

interface Obj {
  [key: string]: unknown;
}

/** A one-event body with the given markets (Arsenal 7 home, Chelsea 9 away). */
function eventWith(markets: unknown[], extra: Obj = {}): Obj {
  return {
    event_id: 'evt1',
    sport_id: 11,
    event_date: '2026-11-01T15:00:00Z',
    score: { event_status: 'STATUS_SCHEDULED', team_id_home: 7, team_id_away: 9 },
    teams: [
      { team_id: 9, name: 'Chelsea', is_away: true, is_home: false },
      { team_id: 7, name: 'Arsenal', is_home: true, is_away: false },
    ],
    markets,
    ...extra,
  };
}
const totals = (value: unknown, prices: unknown = { 3: { price: -105, updated_at: T } }): Obj => ({
  market_id: 3,
  period_id: 0,
  participants: [{ id: 1, type: 'TYPE_RESULT', name: 'Over', lines: [{ value, prices }] }],
});
const moneyline = (prices: unknown, value: unknown = ''): Obj => ({
  market_id: 1,
  period_id: 0,
  participants: [{ id: 7, type: 'TYPE_TEAM', name: 'Arsenal', lines: [{ value, prices }] }],
});
const parseOne = (event: Obj) => parseTherundownEvents(JSON.stringify({ events: [event] }));

describe('parseTherundownEvents, the clean fixture event', () => {
  const result = parseTherundownEvents(day);
  const clean = result.events.find((e) => e.eventId === '816efd1e5767d7133b5bc70c77173a18');

  it('M3: reads home and away from the flags, not from the array order', () => {
    expect(clean?.home).toEqual({ teamId: 7, name: 'Arsenal' });
    expect(clean?.away).toEqual({ teamId: 9, name: 'Chelsea' });
    expect(clean?.status).toBe('STATUS_SCHEDULED');
    expect(clean?.kickoff.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('keeps 3 books x (3 moneyline + 2 total) outcomes', () => {
    expect(clean?.prices).toHaveLength(15);
    const home3 = clean?.prices.find(
      (p) => p.bookId === 3 && p.marketId === 1 && p.outcome === 'home',
    );
    expect(home3).toMatchObject({
      american: -120,
      oddsMilli: 1833,
      line: null,
      isMainLine: true,
      liquidityUsd: 5000,
    });
    const over = clean?.prices.find((p) => p.bookId === 32 && p.outcome === 'over');
    expect(over).toMatchObject({ line: '2.5', american: -108, liquidityUsd: null });
  });

  it('P1 to P3: the messy event loses exactly the bad parts', () => {
    expect(result.counts).toEqual({
      market_not_allowed: 2,
      period_not_allowed: 1,
      unknown_participant: 1,
      off_board: 1,
      closed_price: 1,
      invalid_price: 1,
      line_not_allowed: 2,
      duplicate_price: 1,
    });
    const messy = result.events.find((e) => e.eventId.startsWith('b2c4'));
    const keys = messy?.prices.map((p) => `${p.bookId}|${p.marketId}|${p.outcome}|${p.line}`);
    expect(keys?.sort()).toEqual(
      [
        '3|1|home|null', // "-110" as a string, then the later -115 wins
        '32|1|away|null',
        '3|1|draw|null',
        '3|3|over|2.5',
        '3|3|under|2.5',
      ].sort(),
    );
    expect(messy?.prices.find((p) => p.outcome === 'home')?.american).toBe(-115);
  });
});

describe('P1 allow-list', () => {
  it('P1: drops other markets (spread, live ids, props) with one issue each', () => {
    const markets = [2, 41, 42, 43, 96, 1105, 77].map((id) => ({
      market_id: id,
      period_id: 0,
      participants: [],
    }));
    const r = parseOne(eventWith(markets));
    expect(r.counts.market_not_allowed).toBe(7);
    expect(r.issues[0]?.detail).toContain('market_id 2');
  });

  it('P1: drops every period but 0, and a missing period_id', () => {
    const markets = [7, 13, 18, 1].map((p) => ({ ...moneyline({}), period_id: p }));
    const missing = { ...moneyline({}) };
    delete missing.period_id;
    const r = parseOne(eventWith([...markets, missing]));
    expect(r.counts.period_not_allowed).toBe(5);
  });

  it('P1: allowedMarketIds can narrow the markets', () => {
    const r = parseTherundownEvents(
      JSON.stringify({ events: [eventWith([totals('2.5'), moneyline({})])] }),
      { allowedMarketIds: [1] },
    );
    expect(r.counts.market_not_allowed).toBe(1);
  });
});

describe('P2 prices', () => {
  const priceOf = (price: unknown, extra: Obj = {}) =>
    parseOne(eventWith([moneyline({ 3: { price, updated_at: T, ...extra } })]));

  it('P2: 0.0001 is off the board, never converted (also as a string)', () => {
    for (const p of [0.0001, '0.0001']) {
      const r = priceOf(p);
      expect(r.counts).toEqual({ off_board: 1 });
      expect(r.events[0]?.prices).toEqual([]);
    }
  });

  it('P2: a price with closed_at is closed_price', () => {
    const r = priceOf(-110, { closed_at: T });
    expect(r.counts).toEqual({ closed_price: 1 });
  });

  it('P2: invalid values are invalid_price', () => {
    for (const p of [0, 1.5, 50, -50, 99, 'abc', '', 99901, -100001, null, true, {}]) {
      expect(priceOf(p).counts).toEqual({ invalid_price: 1 });
    }
  });

  it('P2: accepts numbers and numeric strings, converts rounding down', () => {
    expect(priceOf('-110').events[0]?.prices[0]).toMatchObject({ american: -110, oddsMilli: 1909 });
    expect(priceOf('+150').events[0]?.prices[0]).toMatchObject({ american: 150, oddsMilli: 2500 });
    expect(priceOf(-100).events[0]?.prices[0]?.oddsMilli).toBe(2000);
  });

  it('P2: updated_at must be a valid date', () => {
    for (const updated_at of [undefined, 'nope', 5]) {
      const r = parseOne(eventWith([moneyline({ 3: { price: -110, updated_at } })]));
      expect(r.counts).toEqual({ invalid_price: 1 });
    }
  });

  it('P2: book ids are positive integers only', () => {
    for (const key of ['0', '-3', 'abc', '3.5', '']) {
      const r = parseOne(eventWith([moneyline({ [key]: { price: -110, updated_at: T } })]));
      expect(r.counts).toEqual({ invalid_price: 1 });
    }
  });
});

describe('P3 lines and sides', () => {
  const linesKept = (value: unknown) =>
    parseOne(eventWith([totals(value)])).events[0]?.prices.map((p) => p.line);

  it('P3: normalises "+2.5", "2.50" and " 2.5 " to "2.5"', () => {
    for (const v of ['+2.5', '2.50', ' 2.5 ', '02.5', 2.5]) expect(linesKept(v)).toEqual(['2.5']);
    expect(linesKept('215.5')).toEqual(['215.5']);
  });

  it('P3: drops whole, quarter and malformed total lines', () => {
    for (const v of ['2', '3', '2.25', '2.75', '2.0', '', 'x', '-2.5', '1000.5', null, undefined]) {
      const r = parseOne(eventWith([totals(v)]));
      expect(r.counts, String(v)).toEqual({ line_not_allowed: 1 });
      expect(r.events[0]?.prices).toEqual([]);
    }
  });

  it('P3: a moneyline carries no line', () => {
    expect(parseOne(eventWith([moneyline({}, '0.5')])).counts).toEqual({ line_not_allowed: 1 });
    expect(
      parseOne(eventWith([moneyline({ 3: { price: -110, updated_at: T } }, null)])),
    ).toMatchObject({
      counts: {},
    });
  });

  it('P3: over and under come from the name, whatever the type', () => {
    const market = {
      market_id: 3,
      period_id: 0,
      participants: [
        {
          id: 1,
          type: 'TYPE_TEAM',
          name: ' OVER ',
          lines: [{ value: '2.5', prices: { 3: { price: -105, updated_at: T } } }],
        },
        {
          id: 2,
          name: 'under',
          lines: [{ value: '2.5', prices: { 3: { price: -115, updated_at: T } } }],
        },
        {
          id: 3,
          name: 'Both',
          lines: [{ value: '2.5', prices: { 3: { price: -115, updated_at: T } } }],
        },
      ],
    };
    const r = parseOne(eventWith([market]));
    expect(r.events[0]?.prices.map((p) => p.outcome)).toEqual(['over', 'under']);
    expect(r.counts).toEqual({ unknown_participant: 1 });
  });
});

describe('M3 home and away', () => {
  it('M3: is_home / is_away disagreeing with score.team_id_home drops the event', () => {
    const r = parseTherundownEvents(fixture('therundown-swapped.json'));
    expect(r.events).toEqual([]);
    expect(r.counts).toEqual({ home_away_mismatch: 1 });
  });

  it('M3: needs exactly one home and one away with different positive ids', () => {
    const bad: unknown[][] = [
      [],
      [{ team_id: 7, is_home: true }],
      [
        { team_id: 7, is_home: true },
        { team_id: 9, is_home: true },
      ],
      [
        { team_id: 7, is_home: true },
        { team_id: 7, is_away: true },
      ],
      [
        { team_id: 0, is_home: true },
        { team_id: 9, is_away: true },
      ],
    ];
    for (const teams of bad) {
      const r = parseOne(eventWith([], { teams }));
      expect(r.counts, JSON.stringify(teams)).toEqual({ home_away_mismatch: 1 });
    }
  });

  it('M3: a zero or missing score id is not checked', () => {
    for (const score of [undefined, { team_id_home: 0, team_id_away: 0 }, { event_status: 'X' }]) {
      expect(parseOne(eventWith([], { score })).events).toHaveLength(1);
    }
  });

  it('M3: status falls back to STATUS_NOT_AVAILABLE', () => {
    expect(parseOne(eventWith([], { score: undefined })).events[0]?.status).toBe(
      'STATUS_NOT_AVAILABLE',
    );
    expect(parseOne(eventWith([], { score: { event_status: '' } })).events[0]?.status).toBe(
      'STATUS_NOT_AVAILABLE',
    );
  });

  it('M3: moneyline sides come from participant ids, a team named like the other is not swapped', () => {
    const market = {
      market_id: 1,
      period_id: 0,
      participants: [
        {
          id: 9,
          type: 'TYPE_TEAM',
          name: 'Arsenal',
          lines: [{ value: '', prices: { 3: { price: 300, updated_at: T } } }],
        },
        {
          id: 7,
          type: 'TYPE_TEAM',
          name: 'Chelsea',
          lines: [{ value: '', prices: { 3: { price: -120, updated_at: T } } }],
        },
        {
          id: 55,
          type: 'TYPE_TEAM',
          name: 'Other',
          lines: [{ value: '', prices: { 3: { price: 100, updated_at: T } } }],
        },
        {
          id: 3001,
          type: 'TYPE_RESULT',
          name: ' draw ',
          lines: [{ value: '', prices: { 3: { price: 250, updated_at: T } } }],
        },
      ],
    };
    const r = parseOne(eventWith([market]));
    const sides = Object.fromEntries(
      (r.events[0]?.prices ?? []).map((p) => [p.outcome, p.american]),
    );
    expect(sides).toEqual({ away: 300, home: -120, draw: 250 });
    expect(r.counts).toEqual({ unknown_participant: 1 });
  });
});

describe('events, duplicates and shapes', () => {
  it('duplicates: keeps the later updated_at', () => {
    const line = (p: number, at: string) => ({
      value: '',
      prices: { 3: { price: p, updated_at: at } },
    });
    const market = {
      market_id: 1,
      period_id: 0,
      participants: [
        {
          id: 7,
          type: 'TYPE_TEAM',
          name: 'A',
          lines: [line(-110, '2026-10-31T11:00:00Z'), line(-120, '2026-10-31T10:00:00Z')],
        },
      ],
    };
    const r = parseOne(eventWith([market]));
    expect(r.events[0]?.prices.map((p) => p.american)).toEqual([-110]);
    expect(r.counts).toEqual({ duplicate_price: 1 });
  });

  it('an event needs event_id, an integer sport_id and a valid event_date', () => {
    for (const patch of [
      { event_id: '' },
      { event_id: 5 },
      { sport_id: 1.5 },
      { sport_id: '11' },
      { event_date: 'soon' },
      { event_date: undefined },
    ]) {
      const r = parseOne(eventWith([], patch));
      expect(r.counts, JSON.stringify(patch)).toEqual({ invalid_event: 1 });
      expect(r.events).toEqual([]);
    }
  });

  it('an event with no valid price is still returned with its kickoff and status', () => {
    const r = parseOne(eventWith([]));
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.prices).toEqual([]);
  });

  it('accepts the three single-event shapes and bytes', () => {
    const event = eventWith([moneyline({ 3: { price: -110, updated_at: T } })]);
    for (const body of [{ events: [event] }, { event }, event]) {
      const r = parseTherundownEvents(JSON.stringify(body));
      expect(r.events.map((e) => e.eventId)).toEqual(['evt1']);
      expect(r.events[0]?.prices).toHaveLength(1);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(event));
    expect(parseTherundownEvents(bytes).events).toHaveLength(1);
  });

  it('bad JSON, bad UTF-8 and a wrong top-level shape give one fatal issue', () => {
    for (const body of ['{nope', '', '[]', '"x"', '5', 'null', '{"meta":{}}', '{"events":5}']) {
      const r = parseTherundownEvents(body);
      expect(r.events, body).toEqual([]);
      expect(r.issues, body).toHaveLength(1);
      expect(r.issues[0]?.code).toBe('fatal');
      expect(r.counts).toEqual({ fatal: 1 });
    }
    expect(parseTherundownEvents(new Uint8Array([0xff, 0xfe, 0xfd])).counts).toEqual({ fatal: 1 });
  });

  it('a non-object entry in events is an invalid_event, the rest is parsed', () => {
    const r = parseTherundownEvents(JSON.stringify({ events: [5, null, eventWith([])] }));
    expect(r.counts).toEqual({ invalid_event: 2 });
    expect(r.events).toHaveLength(1);
  });

  it('caps the issue list but not the counts', () => {
    const markets = Array.from({ length: 500 }, (_, i) => ({ market_id: 1000 + i, period_id: 0 }));
    const r = parseOne(eventWith(markets));
    expect(r.counts.market_not_allowed).toBe(500);
    expect(r.issues.length).toBeLessThanOrEqual(200);
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        let text: string | undefined;
        try {
          text = JSON.stringify(value);
        } catch {
          return;
        }
        if (text !== undefined) parseTherundownEvents(text);
        parseTherundownEvents(JSON.stringify({ events: [value] }));
      }),
    );
    fc.assert(fc.property(fc.json(), (text) => void parseTherundownEvents(text)));
    fc.assert(fc.property(fc.uint8Array(), (bytes) => void parseTherundownEvents(bytes)));
  });

  it('every returned price is valid and converted with americanToOddsMilli', () => {
    const price = fc.oneof(
      fc.integer({ min: -200_000, max: 200_000 }),
      fc.double({ noDefaultInfinity: true }),
      fc.constantFrom(0.0001, '0.0001', '-110', 'x'),
    );
    fc.assert(
      fc.property(fc.array(price, { maxLength: 8 }), (values) => {
        const prices = Object.fromEntries(
          values.map((p, i) => [String(i + 1), { price: p, updated_at: T }]),
        );
        const r = parseOne(eventWith([moneyline(prices)]));
        for (const p of r.events[0]?.prices ?? []) {
          expect(isValidAmericanOdds(p.american)).toBe(true);
          expect(p.oddsMilli).toBe(americanToOddsMilli(p.american));
        }
      }),
    );
  });
});

describe('URL builders', () => {
  const filters = { marketIds: [1, 3], bookIds: [3, 32, 7] };

  it('builds the day, event, scores and affiliates URLs', () => {
    expect(therundownDayUrl('https://therundown.io/', 11, '2026-11-01', filters)).toBe(
      'https://therundown.io/api/v2/sports/11/events/2026-11-01?market_ids=1,3&affiliate_ids=3,32,7&main_line=true&hide_closed=true&offset=0',
    );
    expect(therundownEventUrl('https://therundown.io', 'a/b c', filters)).toBe(
      'https://therundown.io/api/v2/events/a%2Fb%20c?market_ids=1,3&affiliate_ids=3,32,7&main_line=true&hide_closed=true',
    );
    expect(therundownScoresUrl('https://therundown.io', 11, '2026-11-01')).toBe(
      'https://therundown.io/api/v2/sports/11/events/2026-11-01?affiliate_ids=0&offset=0',
    );
    expect(therundownAffiliatesUrl('https://therundown.io/')).toBe(
      'https://therundown.io/api/v2/affiliates',
    );
  });

  it('never puts a key in a URL', () => {
    expect(therundownDayUrl('https://therundown.io', 11, '2026-11-01', filters)).not.toMatch(
      /key|secret|token/i,
    );
  });

  it('utcDateOf uses the UTC day', () => {
    expect(utcDateOf(new Date('2026-11-01T23:59:59-05:00'))).toBe('2026-11-02');
    expect(utcDateOf(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-01');
    expect(() => utcDateOf(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('rejects invalid arguments with RangeError', () => {
    const base = 'https://therundown.io';
    const bad = [
      () => therundownDayUrl(base, 0, '2026-11-01', filters),
      () => therundownDayUrl(base, 1.5, '2026-11-01', filters),
      () => therundownDayUrl(base, 11, '2026-1-1', filters),
      () => therundownDayUrl(base, 11, '2026-11-01', { ...filters, marketIds: [] }),
      () => therundownDayUrl(base, 11, '2026-11-01', { ...filters, marketIds: [1, 1] }),
      () =>
        therundownDayUrl(base, 11, '2026-11-01', {
          ...filters,
          marketIds: Array.from({ length: 13 }, (_, i) => i + 1),
        }),
      () => therundownDayUrl(base, 11, '2026-11-01', { ...filters, bookIds: [] }),
      () => therundownDayUrl(base, 11, '2026-11-01', { ...filters, bookIds: [0] }),
      () =>
        therundownEventUrl(base, 'x', {
          ...filters,
          bookIds: Array.from({ length: 21 }, (_, i) => i + 1),
        }),
      () => therundownScoresUrl(base, -1, '2026-11-01'),
    ];
    for (const f of bad) expect(f).toThrow(RangeError);
  });
});

describe('config and adapter', () => {
  const good = {
    allowedHosts: ['therundown.io'],
    auth: { header: 'X-TheRundown-Key', secret: 'SCRAPER_SECRET_THERUNDOWN' },
    competitions: [
      { sportId: 11, competition: 'Premier League' },
      { sportId: 14, competition: 'La Liga' },
    ],
    books: { anchors: [3, 32], others: [7] },
  };

  it('accepts a good config and applies the defaults', () => {
    const parsed = TherundownConfigSchema.parse({
      ...good,
      allowedHosts: undefined,
      books: { anchors: [3] },
    });
    expect(parsed.allowedHosts).toEqual(['therundown.io']);
    expect(parsed.markets).toEqual([1, 3]);
    expect(parsed.books.others).toEqual([]);
  });

  it('refuses unknown keys, a missing auth, bad hosts and overlapping books', () => {
    const { auth: _auth, ...noAuth } = good;
    const bad: unknown[] = [
      { ...good, extra: 1 },
      { ...good, books: { ...good.books, extra: 1 } },
      noAuth,
      { ...good, allowedHosts: ['example.com'] },
      { ...good, books: { anchors: [3, 32], others: [32] } },
      { ...good, books: { anchors: [], others: [] } },
      { ...good, books: { anchors: [1, 2, 3, 4, 5, 6] } },
      { ...good, competitions: [] },
      { ...good, competitions: [good.competitions[0], good.competitions[0]] },
      { ...good, competitions: [{ sportId: 11, competition: ' ' }] },
      { ...good, markets: [] },
      { ...good, markets: [1, 1] },
      { ...good, auth: { header: 'X-TheRundown-Key', secret: 'plain-key' } },
    ];
    for (const config of bad) {
      expect(TherundownConfigSchema.safeParse(config).success, JSON.stringify(config)).toBe(false);
    }
  });

  it('createAdapter builds a therundown adapter that plans nothing and parses to nothing', () => {
    const r = createAdapter({
      id: 'trd',
      adapter: 'therundown',
      upstream: 'therundown',
      config: good,
    });
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.adapter.descriptor).toMatchObject({ id: 'trd', kind: 'json_api' });
    expect(r.adapter.allowedHosts).toEqual(['therundown.io']);
    expect(r.adapter.plan(new Date())).toEqual([]);
    const doc: RawDocument = {
      sourceId: 'trd',
      url: 'https://therundown.io/api/v2/sports/11/events/2026-11-01',
      status: 200,
      contentType: 'application/json',
      body: day,
      fetchedAt: new Date(T),
      contentHash: 'x',
    };
    const out = r.adapter.parse(doc);
    expect(out.fixtures).toEqual([]);
    expect(out.results).toEqual([]);
  });

  it('createAdapter reports config errors instead of throwing', () => {
    const r = createAdapter({
      id: 'trd',
      adapter: 'therundown',
      upstream: 'therundown',
      config: { ...good, auth: undefined },
    });
    expect(r.ok).toBe(false);
  });
});

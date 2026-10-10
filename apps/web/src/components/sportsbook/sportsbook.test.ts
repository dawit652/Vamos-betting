import type { EventSummary, MarketView } from '@vamos/contracts';
import { describe, expect, it } from 'vitest';
import {
  eventRef,
  groupMarkets,
  isBettable,
  isListedMarket,
  matchClock,
  periodMessageKey,
  shortLabel,
  slipLeg,
  streamEventIds,
} from './events';
import { LiveStore, parseLiveFrame } from './live-store';
import { DEFAULT_TAB, listHref, parseCursor, parseTab } from './tabs';

const market = (over: Partial<MarketView> = {}): MarketView => ({
  id: 'm1',
  type: '1x2',
  line: null,
  name: { en: 'Match Result', am: 'የጨዋታ ውጤት' },
  status: 'open',
  selections: [
    { id: 's1', code: '1', label: { en: 'Home FC' }, oddsMilli: 1850, open: true },
    { id: 's2', code: 'X', label: { en: 'Draw', am: 'አቻ' }, oddsMilli: 3200, open: true },
    { id: 's3', code: '2', label: { en: 'Away FC' }, oddsMilli: 4100, open: true },
  ],
  ...over,
});

const event: EventSummary = {
  id: 'e1',
  gameId: '1234',
  sport: 'football',
  competition: { slug: 'epl', name: { en: 'Premier League' }, category: { en: 'England' } },
  home: { id: 'h', name: { en: 'Home FC' }, shortName: 'HOM' },
  away: { id: 'a', name: { en: 'Away FC' }, shortName: 'AWA' },
  startTime: '2026-10-10T15:00:00.000Z',
  status: 'live',
  liveMinute: 12,
  period: '1H',
  score: { home: 0, away: 0 },
  mainMarket: market(),
  marketCount: 12,
};

describe('slip legs from the catalogue', () => {
  it('maps an event, market and selection to a betslip leg at the shown price', () => {
    const ref = eventRef(event);
    expect(ref).toEqual({
      eventId: 'e1',
      gameId: '1234',
      sport: 'football',
      home: { en: 'Home FC' },
      away: { en: 'Away FC' },
      startTime: '2026-10-10T15:00:00.000Z',
      live: true,
    });
    const m = market();
    expect(slipLeg(ref, m, m.selections[1]!, 3300)).toEqual({
      ...ref,
      selectionId: 's2',
      oddsMilli: 3300,
      marketName: { en: 'Match Result', am: 'የጨዋታ ውጤት' },
      selectionName: { en: 'Draw', am: 'አቻ' },
    });
    expect(eventRef({ ...event, status: 'scheduled' }).live).toBe(false);
  });
});

describe('markets', () => {
  it('lists open and suspended markets only', () => {
    expect(isListedMarket('open')).toBe(true);
    expect(isListedMarket('suspended')).toBe(true);
    expect(isListedMarket('closed')).toBe(false);
    expect(isListedMarket('settled')).toBe(false);
    expect(isListedMarket('void')).toBe(false);
  });

  it('groups lines of one market type in API order, lines sorted', () => {
    const groups = groupMarkets([
      market({ id: 'a', type: '1x2' }),
      market({ id: 'b', type: 'ou', line: '3.5', name: { en: 'Total' } }),
      market({ id: 'c', type: 'btts' }),
      market({ id: 'd', type: 'ou', line: '1.5', name: { en: 'Total' } }),
      market({ id: 'e', type: 'ou', line: '0.5', status: 'closed' }),
      market({ id: 'f', type: 'cs', status: 'settled' }),
    ]);
    expect(groups.map((g) => g.type)).toEqual(['1x2', 'ou', 'btts']);
    expect(groups[1]!.markets.map((m) => m.id)).toEqual(['d', 'b']);
    expect(groups[1]!.name).toEqual({ en: 'Total' });
  });

  it('is bettable only when market, selection and event are open with valid odds', () => {
    const base = {
      marketStatus: 'open' as const,
      selectionOpen: true,
      bettingOpen: true,
      oddsMilli: 1500,
    };
    expect(isBettable(base)).toBe(true);
    expect(isBettable({ ...base, marketStatus: 'suspended' })).toBe(false);
    expect(isBettable({ ...base, selectionOpen: false })).toBe(false);
    expect(isBettable({ ...base, bettingOpen: false })).toBe(false);
    expect(isBettable({ ...base, oddsMilli: 1000 })).toBe(false);
    expect(isBettable({ ...base, oddsMilli: 1.5 })).toBe(false);
  });

  it('labels list buttons with the selection code', () => {
    expect(shortLabel('x')).toBe('X');
    expect(shortLabel('1')).toBe('1');
    expect(shortLabel('over')).toBe('over');
  });
});

describe('match clock', () => {
  it('shows minutes for football, HT at half time, else the period', () => {
    expect(matchClock({ sport: 'football', minute: 53, period: '2H' })).toEqual({
      kind: 'minute',
      minute: 53,
    });
    expect(matchClock({ sport: 'football', minute: 45, period: 'HT' })).toEqual({
      kind: 'halfTime',
    });
    expect(matchClock({ sport: 'basketball', minute: 18, period: 'Q2' })).toEqual({
      kind: 'period',
      period: 'Q2',
    });
    expect(matchClock({ sport: 'tennis', minute: null, period: 'NS' })).toEqual({ kind: 'none' });
    expect(matchClock({ sport: 'tennis', minute: null, period: null })).toEqual({ kind: 'none' });
  });
});

describe('period labels', () => {
  it('translates the feed period codes and leaves unknown ones as they are', () => {
    expect(periodMessageKey('Q2')).toBe('sportsbook.match.period.Q2');
    expect(periodMessageKey('s3')).toBe('sportsbook.match.period.S3');
    expect(periodMessageKey('OT')).toBe('sportsbook.match.period.OT');
    expect(periodMessageKey('2H')).toBe('sportsbook.match.period.2H');
    expect(periodMessageKey('P7')).toBeNull();
  });
});

describe('list tabs', () => {
  it('parses the tab and cursor from the query string', () => {
    expect(parseTab(undefined)).toBe(DEFAULT_TAB);
    expect(parseTab('today')).toBe('today');
    expect(parseTab(['leagues', 'today'])).toBe('leagues');
    expect(parseTab('live')).toBe('highlights');
    expect(parseCursor('WyIyMDI2Il0')).toBe('WyIyMDI2Il0');
    expect(parseCursor('a b')).toBeUndefined();
    expect(parseCursor(undefined)).toBeUndefined();
  });

  it('builds list links', () => {
    expect(listHref('/', 'highlights')).toBe('/');
    expect(listHref('/', 'today')).toBe('/?tab=today');
    expect(listHref('/sport/tennis', 'upcoming', 'abc')).toBe(
      '/sport/tennis?tab=upcoming&cursor=abc',
    );
    expect(listHref('/', 'highlights', 'abc')).toBe('/?cursor=abc');
  });

  it('caps the live stream filter at 50 unique events', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `e${i % 55}`);
    const capped = streamEventIds(ids);
    expect(capped).toHaveLength(50);
    expect(new Set(capped).size).toBe(50);
  });
});

describe('live stream frames', () => {
  it('parses odds, market and match deltas', () => {
    expect(parseLiveFrame('odds', '{"s":"sel","o":1850,"st":"open"}')).toEqual({
      type: 'odds',
      selectionId: 'sel',
      state: { oddsMilli: 1850, open: true },
    });
    expect(parseLiveFrame('market', '{"k":"mk","st":"suspended"}')).toEqual({
      type: 'market',
      marketId: 'mk',
      status: 'suspended',
    });
    expect(
      parseLiveFrame('match', '{"e":"EV","m":58,"p":"2H","sc":[0,2],"st":"live","b":true}'),
    ).toEqual({
      type: 'match',
      eventId: 'ev',
      state: {
        minute: 58,
        period: '2H',
        score: { home: 0, away: 2 },
        status: 'live',
        bettingOpen: true,
      },
    });
    expect(
      parseLiveFrame('match', '{"e":"ev","m":null,"p":null,"sc":null,"st":"scheduled","b":false}'),
    ).toMatchObject({ state: { score: null, minute: null, bettingOpen: false } });
  });

  it('drops malformed frames', () => {
    expect(parseLiveFrame('odds', 'not json')).toBeNull();
    expect(parseLiveFrame('odds', '{"s":"sel","o":1.85,"st":"open"}')).toBeNull();
    expect(parseLiveFrame('odds', '{"s":"sel","o":1850,"st":"closed"}')).toBeNull();
    expect(parseLiveFrame('market', '{"k":"mk","st":"weird"}')).toBeNull();
    expect(
      parseLiveFrame('match', '{"e":"ev","m":1,"p":null,"sc":[1],"st":"live","b":true}'),
    ).toBeNull();
    expect(parseLiveFrame('match', '{"e":"ev","m":1,"p":null,"sc":null,"st":"live"}')).toBeNull();
    expect(parseLiveFrame('ping', '{}')).toBeNull();
    expect(parseLiveFrame('odds', 'null')).toBeNull();
  });

  it('batches notifications until flush', () => {
    const store = new LiveStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.apply({ type: 'odds', selectionId: 's', state: { oddsMilli: 2000, open: true } });
    store.apply({ type: 'market', marketId: 'm', status: 'suspended' });
    store.apply({
      type: 'match',
      eventId: 'e',
      state: { minute: 1, period: '1H', score: null, status: 'live', bettingOpen: true },
    });
    expect(calls).toBe(0);
    store.flush();
    store.flush();
    expect(calls).toBe(1);
    expect(store.getOdds('s')).toEqual({ oddsMilli: 2000, open: true });
    expect(store.getMarket('m')).toBe('suspended');
    expect(store.getMatch('E')?.minute).toBe(1);
    store.setConnected(false);
    store.flush();
    expect(store.connected).toBe(false);
    expect(calls).toBe(2);
    unsubscribe();
    store.setConnected(true);
    store.flush();
    expect(calls).toBe(2);
  });

  it('drops live values older than a server re-render, keeps newer ones', () => {
    const store = new LiveStore();
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.apply({ type: 'odds', selectionId: 's1', state: { oddsMilli: 1850, open: true } });
    store.apply({ type: 'market', marketId: 'm1', status: 'suspended' });
    // The stream drops; on reconnect the provider asks the server for a re-render.
    const mark = store.mark();
    // A frame arrives while that render is on its way: it is newer than the render.
    store.apply({ type: 'odds', selectionId: 's2', state: { oddsMilli: 2400, open: true } });
    store.flush();
    calls = 0;
    // The new server props arrive (market reopened at 2.10 on the server).
    store.dropUpTo(mark);
    store.flush();
    expect(calls).toBe(1);
    expect(store.getOdds('s1')).toBeUndefined(); // the server's 2.10 shows again
    expect(store.getMarket('m1')).toBeUndefined(); // no longer stuck on suspended
    expect(store.getOdds('s2')).toEqual({ oddsMilli: 2400, open: true });
    // Without a mark (someone else's refresh) everything so far goes.
    store.dropUpTo(store.mark());
    expect(store.getOdds('s2')).toBeUndefined();
    store.flush();
    store.dropUpTo(store.mark());
    store.flush();
    expect(calls).toBe(2); // nothing dropped, nobody notified
  });
});

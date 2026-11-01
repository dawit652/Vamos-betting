import type { ReferenceBudget, ReferenceCandidate, ReferencePollState } from '@vamos/db';
import {
  parseTherundownEvents,
  TherundownConfigSchema,
  type TherundownConfig,
} from '@vamos/scraper';
import { describe, expect, it } from 'vitest';
import { groupPrices, ourOutcome } from '../src/pipeline/reference';
import {
  levelOf,
  MAX_REQUESTS_PER_TICK,
  parseHealthyBooks,
  planRequests,
} from '../src/tasks/therundown';
import { dayBody } from './therundown-bodies';

/** The poller's pure parts: no database, no network. */

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = new Date('2026-10-29T12:00:00Z');
const BASE = 'https://therundown.io';

const config: TherundownConfig = TherundownConfigSchema.parse({
  auth: { header: 'x-therundown-key', secret: 'SCRAPER_SECRET_THERUNDOWN' },
  competitions: [
    { sportId: 11, competition: 'TheRundown EPL' },
    { sportId: 14, competition: 'TheRundown La Liga' },
  ],
  markets: [1, 3],
  books: { anchors: [3, 32], others: [7] },
});

let counter = 0;
const candidate = (
  competitionId: string,
  startsInMs: number,
  extra: Partial<ReferenceCandidate> = {},
): ReferenceCandidate => {
  counter += 1;
  return {
    eventId: `event-${counter}`,
    feedRef: `fx|${counter}`,
    gameId: counter,
    sportId: 'football',
    competitionId,
    homeTeamId: `home-${counter}`,
    awayTeamId: `away-${counter}`,
    startTime: new Date(NOW.getTime() + startsInMs),
    bettingOpen: true,
    closeLeadMs: 0,
    ...extra,
  };
};
const sportOf = new Map([
  ['epl', 11],
  ['liga', 14],
]);
const state = (key: string, ago: number, outcome = 'ok'): ReferencePollState => ({
  provider: 'therundown',
  requestKey: key,
  lastFetchedAt: new Date(NOW.getTime() - ago),
  lastOutcome: outcome,
  lastCost: null,
  details: null,
});
const plan = (
  candidates: ReferenceCandidate[],
  options: {
    level?: 'unknown' | 'green' | 'amber' | 'red';
    mapped?: Map<string, string>;
    states?: ReferencePollState[];
  } = {},
) =>
  planRequests({
    config,
    baseUrl: BASE,
    now: NOW,
    level: options.level ?? 'green',
    candidates,
    sportOf,
    mapped: options.mapped ?? new Map(),
    states: new Map((options.states ?? []).map((s) => [s.requestKey, s])),
  });
const keys = (due: ReturnType<typeof plan>) => due.map((d) => d.key);

describe('planRequests', () => {
  it('groups candidates into one day request per sport and UTC day, at the fastest tier in the group', () => {
    const due = plan([
      candidate('epl', 30 * HOUR),
      candidate('epl', 30 * HOUR + 10 * MINUTE),
      candidate('epl', 5 * HOUR),
      candidate('liga', 30 * HOUR),
    ]);
    // 2026-10-30 18:00 (30 h) and 2026-10-30 18:10 are one day; 17:00 on the 29th is another.
    expect(keys(due).filter((k) => k.startsWith('day:'))).toEqual([
      'day:11:2026-10-29', // 5 h: the 'day' tier, so it comes first
      'day:11:2026-10-30',
      'day:14:2026-10-30',
    ]);
    const affiliates = due.find((d) => d.key === 'affiliates');
    expect(affiliates?.url).toBe('https://therundown.io/api/v2/affiliates');
    expect(due[0]!.key).toBe('affiliates');
    expect(due.find((d) => d.key === 'day:11:2026-10-30')?.url).toBe(
      'https://therundown.io/api/v2/sports/11/events/2026-10-30?market_ids=1,3&affiliate_ids=3,32,7&main_line=true&hide_closed=true&offset=0',
    );
  });

  it('polls a mapped event of the last 3 hours alone, every minute, and leaves it out of the day request', () => {
    const near = candidate('epl', 2 * HOUR);
    const mapped = new Map([[near.eventId, 'abc123']]);
    const states = [state('affiliates', 5 * MINUTE), state('event:abc123', 61 * 1000)];
    const due = plan([near], { mapped, states });
    expect(keys(due)).toEqual(['event:abc123']);
    expect(due[0]!.url).toBe(
      'https://therundown.io/api/v2/events/abc123?market_ids=1,3&affiliate_ids=3,32,7&main_line=true&hide_closed=true',
    );
    // Not due yet 59 s after the last request; a near event that is not mapped uses the day request.
    expect(
      plan([near], { mapped, states: [...states.slice(0, 1), state('event:abc123', 59_000)] }),
    ).toEqual([]);
    expect(keys(plan([near], { states: [state('affiliates', 5 * MINUTE)] }))).toEqual([
      'day:11:2026-10-29',
    ]);
  });

  it('is due when the interval of its tier has passed, and never before', () => {
    const c = candidate('epl', 30 * HOUR); // two_days tier: 20 minutes
    const only = (ago: number) =>
      keys(
        plan([c], { states: [state('affiliates', 1 * MINUTE), state('day:11:2026-10-30', ago)] }),
      );
    expect(only(19 * MINUTE)).toEqual([]);
    expect(only(20 * MINUTE)).toEqual(['day:11:2026-10-30']);
    // Amber: the two slowest tiers poll half as often.
    const amber = (ago: number) =>
      keys(
        plan([c], {
          level: 'amber',
          states: [state('affiliates', 1 * MINUTE), state('day:11:2026-10-30', ago)],
        }),
      );
    expect(amber(39 * MINUTE)).toEqual([]);
    expect(amber(40 * MINUTE)).toEqual(['day:11:2026-10-30']);
  });

  it('asks for no price at red, and for the books once an hour', () => {
    const c = candidate('epl', 30 * HOUR);
    expect(plan([c], { level: 'red' })).toEqual([]);
    expect(keys(plan([c], { states: [state('affiliates', 59 * MINUTE)] }))).not.toContain(
      'affiliates',
    );
    expect(keys(plan([c], { states: [state('affiliates', 60 * MINUTE)] }))).toContain('affiliates');
    // Nothing to check without candidates.
    expect(plan([])).toEqual([]);
  });

  it('makes at most 10 requests, nearest first', () => {
    // 14 (sport, day) groups inside the 7 days: two sports, a candidate every 11 hours.
    const many = Array.from({ length: 14 }, (_, i) =>
      candidate(i % 2 === 0 ? 'epl' : 'liga', (24 + 11 * i) * HOUR),
    );
    const due = plan(many);
    expect(due).toHaveLength(MAX_REQUESTS_PER_TICK);
    expect(due[0]!.key).toBe('affiliates');
    expect(keys(due)[1]).toBe('day:11:2026-10-30');
  });

  it('skips a candidate of a competition with no sport id and one that has started', () => {
    expect(plan([candidate('other', 30 * HOUR), candidate('epl', -MINUTE)])).toEqual([]);
  });
});

describe('parseHealthyBooks', () => {
  const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  it('reads a bare array and { affiliates }, with affiliate_id or id, healthy only', () => {
    const list = [
      { affiliate_id: 3, status: 'healthy' },
      { id: 7, status: 'healthy' },
      { id: '32', status: 'healthy' },
      { affiliate_id: 9, status: 'beta' },
      { affiliate_id: 19, status: 'unhealthy' },
      { affiliate_id: 12 },
      { affiliate_id: -1, status: 'healthy' },
      'junk',
    ];
    expect([...parseHealthyBooks(body(list))!].sort((a, b) => a - b)).toEqual([3, 7, 32]);
    expect([...parseHealthyBooks(body({ affiliates: list }))!].sort((a, b) => a - b)).toEqual([
      3, 7, 32,
    ]);
  });

  it('is null (unknown) for anything else', () => {
    expect(parseHealthyBooks(body({ nope: [] }))).toBeNull();
    expect(parseHealthyBooks(body('text'))).toBeNull();
    expect(parseHealthyBooks(new TextEncoder().encode('not json'))).toBeNull();
    expect(parseHealthyBooks(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe('levelOf', () => {
  const budget = (over: Partial<ReferenceBudget> = {}): ReferenceBudget => ({
    provider: 'therundown',
    used: 1_000,
    remaining: 24_999_000,
    resetAt: new Date(NOW.getTime() + 20 * 24 * HOUR),
    observedAt: NOW,
    spentDay: '2026-10-29',
    spentToday: 0,
    delaySeconds: 60,
    rateLimit: 2,
    level: 'green',
    updatedAt: NOW,
    ...over,
  });
  const none = new Map<string, ReferencePollState>();
  const QUOTA = 25_000_000;

  it("is unknown without a reading, green on pace, amber over today's allowance, red under the reserve", () => {
    expect(levelOf(null, QUOTA, NOW, none)).toBe('unknown');
    expect(levelOf(budget(), QUOTA, NOW, none)).toBe('green');
    expect(levelOf(budget({ spentToday: 5_000_000 }), QUOTA, NOW, none)).toBe('amber');
    expect(levelOf(budget({ remaining: 1_000_000 }), QUOTA, NOW, none)).toBe('red');
  });

  it("does not count yesterday's spend, and treats a reading from before the reset as unknown", () => {
    expect(
      levelOf(budget({ spentDay: '2026-10-28', spentToday: 9_000_000 }), QUOTA, NOW, none),
    ).toBe('green');
    expect(
      levelOf(
        budget({ remaining: 10, resetAt: new Date(NOW.getTime() - MINUTE) }),
        QUOTA,
        NOW,
        none,
      ),
    ).toBe('unknown');
  });

  it('is red while a quota 429 holds, then follows the meters again', () => {
    const hold = (until: Date): ReferencePollState => ({
      ...state('quota', MINUTE, 'quota_exhausted'),
      details: { until: until.toISOString() },
    });
    const held = new Map([['quota', hold(new Date(NOW.getTime() + HOUR))]]);
    expect(levelOf(budget(), QUOTA, NOW, held)).toBe('red');
    const over = new Map([['quota', hold(new Date(NOW.getTime() - MINUTE))]]);
    expect(levelOf(budget(), QUOTA, NOW, over)).toBe('green');
  });
});

describe('prices into our markets', () => {
  it('maps football 1X2 and the half-point total, basketball and tennis; nothing we do not offer', () => {
    const parsed = parseTherundownEvents(
      dayBody([{ id: 'e1', kickoff: new Date(NOW.getTime() + HOUR) }]),
    );
    const prices = parsed.events[0]!.prices;
    const football = groupPrices('football', prices);
    expect([...football.keys()].sort()).toEqual(['1x2', 'ou:2.5']);
    expect([...new Set(football.get('1x2')!.rows.map((r) => r.outcome))].sort()).toEqual([
      '1',
      '2',
      'X',
    ]);
    expect([...new Set(football.get('ou:2.5')!.rows.map((r) => r.outcome))].sort()).toEqual([
      'over',
      'under',
    ]);
    expect([...football.get('1x2')!.books.keys()].sort((a, b) => a - b)).toEqual([3, 7, 32]);

    const basketball = groupPrices('basketball', prices);
    expect([...basketball.keys()].sort()).toEqual(['ml', 'total:2.5']);
    // No draw in basketball: only the two sides.
    expect([...new Set(basketball.get('ml')!.rows.map((r) => r.outcome))].sort()).toEqual([
      '1',
      '2',
    ]);
    const tennis = groupPrices('tennis', prices);
    expect([...tennis.keys()]).toEqual(['winner']);
    expect(groupPrices('volleyball', prices).size).toBe(0);
    expect(
      ourOutcome(
        'tennis',
        prices.find((p) => p.marketId === 3)!,
      ),
    ).toBeNull();
  });
});

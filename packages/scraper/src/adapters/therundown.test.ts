import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RawDocument, SourceAdapter } from '../types';
import {
  americanToMilli,
  createAdapter,
  decimalToMilli,
  MAX_ISSUES,
  MAX_RECORDS,
  exactDecimal,
  safeParse,
  therundownUrls,
  TheRundownConfigSchema,
} from './index';

/**
 * The golden file is SYNTHETIC: built from the documented shape of TheRundown's API (its
 * open-source MCP client), not a recorded response. Replace it with one real response, the key
 * removed, when one is available (see __fixtures__/README.md).
 */
const GOLDEN = readFileSync(new URL('./__fixtures__/therundown-epl.json', import.meta.url), 'utf8');
const FETCHED_AT = new Date('2026-11-01T10:00:00Z');
const URL_EPL =
  'https://therundown.io/api/v2/sports/11/events/2026-11-07?market_ids=1,3&main_line=true&hide_closed=true';

const config = {
  allowedHosts: ['therundown.io'],
  secret: 'SCRAPER_SECRET_THERUNDOWN',
  sports: [{ sportId: 11, competition: 'Premier League' }],
};

function build(cfg: unknown = config): SourceAdapter {
  const r = createAdapter({
    id: 'therundown-epl',
    adapter: 'therundown',
    upstream: 'therundown',
    config: cfg,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.adapter;
}
function refused(cfg: unknown): string[] {
  const r = createAdapter({ id: 's', adapter: 'therundown', upstream: 'u', config: cfg });
  if (r.ok) throw new Error('expected the config to be refused');
  return r.errors;
}
const doc = (body: string, url = URL_EPL): RawDocument => ({
  sourceId: 'therundown-epl',
  url,
  status: 200,
  contentType: 'application/json',
  body,
  fetchedAt: FETCHED_AT,
  contentHash: 'h',
});
const parse = (body: string, cfg: unknown = config, url?: string) =>
  safeParse(build(cfg), doc(body, url));

describe('therundown config', () => {
  it('accepts the minimum and fills the defaults', () => {
    const parsed = TheRundownConfigSchema.parse(config);
    expect(parsed).toMatchObject({
      daysBack: 1,
      daysAhead: 3,
      marketIds: [1, 3],
      periodId: 0,
      priceFormat: 'american',
      moneylineMarketId: 1,
      totalsMarketId: 3,
      drawNames: ['Draw', 'Tie'],
      finalIsRegularTime: true,
    });
    expect(parsed.affiliateIds).toBeUndefined();
    expect(createAdapter({ id: 's', adapter: 'therundown', upstream: 'u', config }).ok).toBe(true);
  });

  it('is of kind licensed_api and covers therundown.io (S3)', () => {
    const adapter = build();
    expect(adapter.descriptor.kind).toBe('licensed_api');
    expect(adapter.allowedHosts).toContain('therundown.io');
    expect(refused({ ...config, allowedHosts: ['api.example.com'] }).join()).toContain(
      'allowedHosts must cover therundown.io',
    );
    expect(refused({ ...config, allowedHosts: [] }).length).toBeGreaterThan(0);
    const { allowedHosts: _a, ...without } = config;
    expect(refused(without).length).toBeGreaterThan(0);
  });

  it.each([
    ['unknown key', { ...config, apiKey: 'x' }],
    ['no secret', { ...config, secret: undefined }],
    ['a secret outside the namespace', { ...config, secret: 'DATABASE_URL' }],
    ['no sports', { ...config, sports: [] }],
    ['a sport listed twice', { ...config, sports: [config.sports[0], config.sports[0]] }],
    ['a bad price format', { ...config, priceFormat: 'fractional' }],
    ['daysAhead above 14', { ...config, daysAhead: 15 }],
    ['negative daysBack', { ...config, daysBack: -1 }],
    ['the retired affiliate', { ...config, affiliateIds: [19, 27] }],
    ['market ids that exclude both markets', { ...config, marketIds: [2] }],
    ['one market for both', { ...config, totalsMarketId: 1 }],
    [
      'too many requests',
      {
        ...config,
        daysAhead: 14,
        daysBack: 7,
        sports: [1, 2].map((sportId) => ({ sportId, competition: 'x' })),
      },
    ],
    ['an empty competition label', { ...config, sports: [{ sportId: 11, competition: ' ' }] }],
  ])('refuses %s', (_why, cfg) => {
    expect(refused(cfg).length).toBeGreaterThan(0);
  });

  it('refuses a key written into the config, wherever it is put, without repeating it', () => {
    const KEY = 'f00dfeedf00dfeedf00dfeedf00dfeed';
    const attempts = [
      { ...config, secret: KEY },
      { ...config, apiKey: KEY },
      { ...config, auth: { header: 'x-therundown-key', value: KEY } },
      { ...config, headers: { 'X-TheRundown-Key': KEY } },
      { ...config, sports: [{ sportId: 11, competition: 'L', key: KEY }] },
    ];
    for (const attempt of attempts) {
      const found = refused(attempt);
      expect(found.length).toBeGreaterThan(0);
      expect(found.join('\n')).not.toContain(KEY);
    }
  });
});

describe('therundown plan', () => {
  const now = new Date('2026-11-01T23:30:00Z');

  it('asks one URL per sport per UTC date, small, with the key as a reference only', () => {
    const plan = build().plan(now);
    expect(plan.map((p) => p.url)).toEqual(
      ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map(
        (d) =>
          `https://therundown.io/api/v2/sports/11/events/${d}?market_ids=1,3&main_line=true&hide_closed=true`,
      ),
    );
    for (const item of plan) {
      expect(item.auth).toEqual({
        header: 'X-TheRundown-Key',
        secret: 'SCRAPER_SECRET_THERUNDOWN',
      });
      expect(item.purpose).toBe('both');
      expect(Object.keys(item).sort()).toEqual(['auth', 'purpose', 'url']);
      expect(item.url).not.toMatch(/key|secret/i);
    }
  });

  it('multiplies by sports, honours the day window, affiliates and market ids', () => {
    const urls = therundownUrls(
      TheRundownConfigSchema.parse({
        ...config,
        sports: [
          { sportId: 11, competition: 'Premier League' },
          { sportId: 10, competition: 'MLS' },
        ],
        daysBack: 0,
        daysAhead: 1,
        marketIds: [1, 2, 3],
        affiliateIds: [19, 23],
      }),
      now,
    );
    expect(urls).toEqual([
      'https://therundown.io/api/v2/sports/11/events/2026-11-01?market_ids=1,2,3&affiliate_ids=19,23&main_line=true&hide_closed=true',
      'https://therundown.io/api/v2/sports/11/events/2026-11-02?market_ids=1,2,3&affiliate_ids=19,23&main_line=true&hide_closed=true',
      'https://therundown.io/api/v2/sports/10/events/2026-11-01?market_ids=1,2,3&affiliate_ids=19,23&main_line=true&hide_closed=true',
      'https://therundown.io/api/v2/sports/10/events/2026-11-02?market_ids=1,2,3&affiliate_ids=19,23&main_line=true&hide_closed=true',
    ]);
  });

  it('every planned URL is https on an allowed host', () => {
    for (const item of build().plan(now)) {
      const url = new URL(item.url);
      expect(url.protocol).toBe('https:');
      expect(build().allowedHosts).toContain(url.hostname);
    }
  });
});

describe('therundown parse: the synthetic golden file', () => {
  const out = parse(GOLDEN);

  it('reads fixtures and results with the statuses mapped', () => {
    expect(out.issues.filter((i) => i.fatal)).toEqual([]);
    expect(out.stats).toEqual({ recordsSeen: 7, recordsAccepted: 6 });
    expect(
      out.fixtures.map((f) => [f.externalRef, f.status, f.home, f.away, f.competition]).sort(),
    ).toEqual([
      ['ev-ars-che-0001', 'scheduled', 'Arsenal', 'Chelsea', 'Premier League'],
      ['ev-avl-wol-0006', 'scheduled', 'Aston Villa', 'Wolverhampton Wanderers', 'Premier League'],
      ['ev-mci-tot-0003', 'postponed', 'Manchester City', 'Tottenham Hotspur', 'Premier League'],
      [
        'ev-new-bha-0004',
        'scheduled',
        'Newcastle United',
        'Brighton and Hove Albion',
        'Premier League',
      ],
      ['ev-whu-ful-0005', 'scheduled', 'West Ham United', 'Fulham', 'Premier League'],
    ]);
    const arsenal = out.fixtures.find((f) => f.externalRef === 'ev-ars-che-0001');
    expect(arsenal?.kickoff).toEqual(new Date('2026-11-07T15:00:00Z'));
    expect(arsenal?.observedAt).toEqual(FETCHED_AT);
    expect(arsenal?.sport).toBe('football');
    expect(out.results.map((r) => [r.externalRef, r.status]).sort()).toEqual([
      ['ev-liv-eve-0002', 'finished'],
      ['ev-mci-tot-0003', 'postponed'],
    ]);
    const final = out.results.find((r) => r.status === 'finished');
    expect(final?.score).toEqual({ home: 2, away: 1, htHome: null, htAway: null });
    expect(final?.scoreBasis).toBe('regular_time');
    expect(out.results.find((r) => r.status === 'postponed')?.score).toBeNull();
  });

  it('never turns a postponement or an unknown status into anything but a review-bound status', () => {
    expect(out.results.some((r) => r.status === 'cancelled' || r.status === 'abandoned')).toBe(
      false,
    );
    const unknown = out.issues.find((i) => i.code === 'unknown_status');
    expect(unknown).toMatchObject({
      severity: 'warning',
      context: { eventId: 'ev-bre-cry-0007', value: 'STATUS_DELAYED' },
    });
    expect(out.fixtures.some((f) => f.externalRef === 'ev-bre-cry-0007')).toBe(false);
  });

  it('stores one market_odds row per event, market, selection and affiliate, rounded down', () => {
    const rows = out.marketOdds.filter((r) => r.externalRef === 'ev-ars-che-0001');
    const key = (r: (typeof rows)[number]) =>
      `${r.market}|${r.line ?? '-'}|${r.bookmaker}|${r.selection}`;
    expect(Object.fromEntries(rows.map((r) => [key(r), r.priceMilli]))).toEqual({
      '1x2|-|19|1': 2500,
      '1x2|-|19|X': 3500,
      '1x2|-|19|2': 2800,
      '1x2|-|23|1': 2450,
      '1x2|-|23|X': 3550,
      '1x2|-|23|2': 2850,
      'ou|2.5|19|over': 1909,
      'ou|2.5|19|under': 1909,
      'ou|2.5|23|over': 1952,
      'ou|2.5|23|under': 1869,
    });
    const one = rows.find((r) => key(r) === '1x2|-|19|1');
    expect(one).toMatchObject({
      kind: 'market_odds',
      sport: 'football',
      competition: 'Premier League',
      home: 'Arsenal',
      away: 'Chelsea',
      kickoff: new Date('2026-11-07T15:00:00Z'),
      observedAt: FETCHED_AT,
      // the price's own timestamp, not the fetch time
      priceUpdatedAt: new Date('2026-11-01T09:05:00Z'),
    });
    expect(rows.find((r) => key(r) === 'ou|2.5|19|over')?.priceUpdatedAt).toEqual(
      new Date('2026-11-01T09:12:00Z'),
    );
  });

  it('ignores the retired affiliate, other periods and other markets', () => {
    expect(out.marketOdds.some((r) => r.bookmaker === '27')).toBe(false);
    // the first-half moneyline (period 1, affiliate 19, +190) and the spread are not read
    expect(out.marketOdds.some((r) => r.priceMilli === 2900)).toBe(false);
    expect(out.marketOdds.filter((r) => r.externalRef === 'ev-avl-wol-0006')).toEqual([]);
  });

  it('drops a price that is closed and with it the incomplete 1x2 book, keeping the other affiliate', () => {
    const rows = out.marketOdds.filter((r) => r.externalRef === 'ev-new-bha-0004');
    expect(rows.map((r) => `${r.bookmaker}|${r.selection}`).sort()).toEqual([
      '23|1',
      '23|2',
      '23|X',
    ]);
  });

  it('drops a price that is not the main line and with it the over/under book', () => {
    const rows = out.marketOdds.filter((r) => r.externalRef === 'ev-whu-ful-0005');
    expect(new Set(rows.map((r) => r.market))).toEqual(new Set(['1x2']));
    expect(rows).toHaveLength(3);
  });

  it('reads prices of matches not yet played only, and every row validates', () => {
    expect(out.marketOdds.some((r) => r.externalRef === 'ev-mci-tot-0003')).toBe(false);
    expect(out.marketOdds).toHaveLength(16);
    for (const r of out.marketOdds) {
      expect(Number.isInteger(r.priceMilli)).toBe(true);
      expect(r.priceMilli).toBeGreaterThanOrEqual(1010);
      expect(r.line === null).toBe(r.market === '1x2');
    }
  });

  it('says what it left out in one summary warning', () => {
    const summary = out.issues.find((i) => i.code === 'prices_dropped');
    expect(summary?.severity).toBe('warning');
    expect(summary?.context).toMatchObject({
      skipped_retired: 5,
      skipped_closed: 1,
      skipped_not_main_line: 1,
      otherPeriod: 1,
      incompleteBooks: 2,
    });
  });

  it('is deterministic and never throws on the same bytes', () => {
    expect(parse(GOLDEN)).toEqual(out);
  });
});

describe('therundown parse: formats, statuses and shapes', () => {
  const base = (events: unknown[]) => JSON.stringify({ events });
  const team = (id: number, name: string, home: boolean) => ({
    team_id: id,
    name,
    is_home: home,
    is_away: !home,
  });
  const price = (p: unknown, extra: Record<string, unknown> = {}) => ({
    price: p,
    is_main_line: true,
    updated_at: '2026-11-01T09:00:00Z',
    closed_at: null,
    ...extra,
  });
  const book = (home: unknown, draw: unknown, away: unknown, aff = '19') => ({
    market_id: 1,
    period_id: 0,
    participants: [
      { id: 1, name: 'A', lines: [{ value: 0, prices: { [aff]: price(home) } }] },
      { id: 99, name: 'Draw', lines: [{ value: 0, prices: { [aff]: price(draw) } }] },
      { id: 2, name: 'B', lines: [{ value: 0, prices: { [aff]: price(away) } }] },
    ],
  });
  const event = (
    markets: unknown[],
    score: Record<string, unknown> = { event_status: 'STATUS_SCHEDULED' },
  ) => ({
    event_id: 'e1',
    sport_id: 11,
    event_date: '2026-11-07T15:00:00Z',
    teams: [team(1, 'A', true), team(2, 'B', false)],
    score,
    markets,
  });

  it('reads decimal prices exactly when the format is decimal', () => {
    const out = parse(base([event([book(1.85, 3.4, 4.05)])]), {
      ...config,
      priceFormat: 'decimal',
    });
    expect(out.marketOdds.map((r) => [r.selection, r.priceMilli])).toEqual([
      ['1', 1850],
      ['X', 3400],
      ['2', 4050],
    ]);
  });

  it('accepts American prices as text, with a plus sign', () => {
    const out = parse(base([event([book('+150', '-110', '+1000')])]));
    expect(out.marketOdds.map((r) => r.priceMilli)).toEqual([2500, 1909, 11000]);
  });

  it('a feed in decimal read as American is a FATAL issue, nothing is stored', () => {
    const out = parse(base([event([book(1.85, 3.4, 4.05)])]));
    expect(out.issues[0]).toMatchObject({ fatal: true, code: 'wrong_price_format' });
    expect(out.issues[0]?.message).toContain('priceFormat');
    expect(out.marketOdds).toEqual([]);
    expect(out.fixtures).toEqual([]);
    expect(out.stats.recordsAccepted).toBe(0);
  });

  it('a feed in American read as decimal is fatal when every price fails, and when half of many do', () => {
    const allNegative = parse(base([event([book(-150, -110, -200)])]), {
      ...config,
      priceFormat: 'decimal',
    });
    expect(allNegative.issues[0]).toMatchObject({ fatal: true, code: 'wrong_price_format' });
    // positives above +100 pass as decimal (150 is "150.0"), negatives fail: about half fail
    const events = Array.from({ length: 6 }, (_, i) => ({
      ...event([book(+150, -110, -200)]),
      event_id: `e${i}`,
    }));
    const mixed = parse(base(events), { ...config, priceFormat: 'decimal' });
    expect(mixed.issues[0]).toMatchObject({ fatal: true, code: 'wrong_price_format' });
    expect(mixed.marketOdds).toEqual([]);
  });

  it('a few bad prices among many good ones drop only their books, with a warning', () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      ...event([book(+150, +240, +180)]),
      event_id: `e${i}`,
    }));
    events[2] = { ...event([book(+150, 12, +180)]), event_id: 'e2' }; // 12 is not an American price
    const out = parse(base(events));
    expect(out.issues.some((i) => i.fatal)).toBe(false);
    expect(new Set(out.marketOdds.map((r) => r.externalRef))).toEqual(
      new Set(['e0', 'e1', 'e3', 'e4', 'e5']),
    );
    expect(out.issues.find((i) => i.code === 'prices_dropped')?.context).toMatchObject({
      formatFailures: 1,
      incompleteBooks: 1,
    });
  });

  it('skips a price of 0 or 0.0001 like the provider client, without calling it a format failure', () => {
    const out = parse(base([event([book(0, 0.0001, 150)])]));
    expect(out.marketOdds).toEqual([]);
    expect(out.issues.some((i) => i.fatal)).toBe(false);
  });

  it('drops a price without a valid updated_at (a fetch time is not freshness)', () => {
    const m = book(+150, +240, +180) as {
      participants: { lines: { prices: Record<string, Record<string, unknown>> }[] }[];
    };
    delete m.participants[0]?.lines[0]?.prices['19']?.updated_at;
    const out = parse(base([event([m])]));
    expect(out.marketOdds).toEqual([]);
    expect(out.issues.find((i) => i.code === 'prices_dropped')?.context).toMatchObject({
      badUpdatedAt: 1,
    });
  });

  it('matches the draw by name, the teams by team_id or by name', () => {
    const m = {
      market_id: 1,
      period_id: 0,
      participants: [
        { id: 'x', name: 'A', lines: [{ prices: { '19': price(150) } }] },
        { id: 'y', name: 'tie', lines: [{ prices: { '19': price(240) } }] },
        { id: 'z', name: 'B', lines: [{ prices: { '19': price(180) } }] },
      ],
    };
    const out = parse(base([event([m])]));
    expect(out.marketOdds.map((r) => r.selection)).toEqual(['1', 'X', '2']);
    const custom = parse(
      base([
        event([
          {
            ...m,
            participants: m.participants.map((p) => ({
              ...p,
              name: p.name === 'tie' ? 'Empate' : p.name,
            })),
          },
        ]),
      ]),
      {
        ...config,
        drawNames: ['Empate'],
      },
    );
    expect(custom.marketOdds.map((r) => r.selection)).toEqual(['1', 'X', '2']);
  });

  it('keeps only x.5 over/under lines and needs both sides of the same line', () => {
    const ou = (line: unknown, over: unknown, under: unknown) => ({
      market_id: 3,
      period_id: 0,
      participants: [
        { name: 'Over', lines: [{ value: line, prices: { '19': price(over) } }] },
        { name: 'Under', lines: [{ value: line, prices: { '19': price(under) } }] },
      ],
    });
    const out = parse(base([event([ou(2.5, -110, -110)])]));
    expect(out.marketOdds.map((r) => [r.line, r.selection])).toEqual([
      ['2.5', 'over'],
      ['2.5', 'under'],
    ]);
    expect(parse(base([event([ou('3.5', -120, 100)])])).marketOdds.map((r) => r.line)).toEqual([
      '3.5',
      '3.5',
    ]);
    expect(parse(base([event([ou(2.25, -110, -110)])])).marketOdds).toEqual([]);
    expect(parse(base([event([ou(3, -110, -110)])])).marketOdds).toEqual([]);
    expect(parse(base([event([ou('abc', -110, -110)])])).marketOdds).toEqual([]);
  });

  it('drops a book that lists one selection at two different prices', () => {
    const m = book(+150, +240, +180) as { participants: { lines: unknown[] }[] };
    m.participants[0]?.lines.push({ value: 0, prices: { '19': price(+155) } });
    const out = parse(base([event([m])]));
    expect(out.marketOdds).toEqual([]);
    expect(out.issues.find((i) => i.code === 'prices_dropped')?.context).toMatchObject({
      conflictingBooks: 1,
    });
  });

  it('honours the affiliate filter', () => {
    const m = book(+150, +240, +180, '23');
    const out = parse(base([event([m])]), { ...config, affiliateIds: [19] });
    expect(out.marketOdds).toEqual([]);
    expect(parse(base([event([m])]), { ...config, affiliateIds: [23] }).marketOdds).toHaveLength(3);
  });

  it('a final score is a regular-time score only when the config says so', () => {
    const final = event([], { event_status: 'STATUS_FINAL', score_home: 1, score_away: 0 });
    expect(parse(base([final])).results[0]?.scoreBasis).toBe('regular_time');
    expect(parse(base([final]), { ...config, finalIsRegularTime: false }).results[0]).toMatchObject(
      {
        status: 'finished',
        scoreBasis: 'unknown',
      },
    );
  });

  it('never derives a final from a score: a live match records nothing, an unknown status warns', () => {
    const live = event([book(+150, +240, +180)], {
      event_status: 'STATUS_IN_PROGRESS',
      score_home: 1,
      score_away: 0,
    });
    const out = parse(base([live]));
    expect(out.fixtures).toEqual([]);
    expect(out.results).toEqual([]);
    expect(out.marketOdds).toEqual([]);
    for (const status of ['STATUS_FINAL_PEN', 'STATUS_SUSPENDED', 'whatever']) {
      const unknown = parse(
        base([event([], { event_status: status, score_home: 1, score_away: 0 })]),
      );
      expect(unknown.results).toEqual([]);
      expect(unknown.issues[0]).toMatchObject({ severity: 'warning', code: 'unknown_status' });
    }
    const noScore = parse(base([{ ...event([]), score: undefined }]));
    expect(noScore.issues[0]).toMatchObject({ severity: 'warning', code: 'missing_status' });
  });

  it('maps cancelled and abandoned like the other adapters (review-bound, never applied here)', () => {
    const out = parse(
      base([
        { ...event([], { event_status: 'STATUS_CANCELED' }), event_id: 'c' },
        { ...event([], { event_status: 'STATUS_ABANDONED' }), event_id: 'a' },
      ]),
    );
    expect(out.results.map((r) => [r.externalRef, r.status]).sort()).toEqual([
      ['a', 'abandoned'],
      ['c', 'cancelled'],
    ]);
    expect(out.results.every((r) => r.score === null)).toBe(true);
  });

  it('drops a final without whole-number scores', () => {
    for (const score of [
      { score_home: null, score_away: 1 },
      { score_home: 1.5, score_away: 1 },
      { score_home: '-1', score_away: 0 },
    ]) {
      const out = parse(base([event([], { event_status: 'STATUS_FINAL', ...score })]));
      expect(out.results).toEqual([]);
      expect(out.issues[0]).toMatchObject({ code: 'bad_score' });
    }
  });

  it('uses teams_normalized when teams is absent, and refuses ambiguous home/away', () => {
    const { teams, ...rest } = event([]);
    expect(parse(base([{ ...rest, teams_normalized: teams }])).fixtures).toHaveLength(1);
    const bothHome = { ...rest, teams: [team(1, 'A', true), team(2, 'B', true)] };
    expect(parse(base([bothHome])).issues[0]).toMatchObject({ code: 'bad_name' });
    expect(parse(base([{ ...rest, teams: [] }])).fixtures).toEqual([]);
  });

  it('refuses a kickoff without an offset, an event of another sport id and a missing event_id', () => {
    expect(
      parse(base([{ ...event([]), event_date: '2026-11-07T15:00:00' }])).issues[0],
    ).toMatchObject({ code: 'bad_time' });
    expect(parse(base([{ ...event([]), sport_id: 10 }])).issues[0]).toMatchObject({
      code: 'sport_mismatch',
    });
    expect(parse(base([{ ...event([]), event_id: undefined }])).issues[0]).toMatchObject({
      code: 'bad_record',
    });
  });

  it('fatal on a document that is not JSON, has no events array or a URL of no configured sport', () => {
    expect(parse('<html>').issues[0]).toMatchObject({ fatal: true, code: 'bad_json' });
    expect(parse('{"message":"unauthorized"}').issues[0]).toMatchObject({
      fatal: true,
      code: 'bad_shape',
    });
    const other = parse(
      base([]),
      config,
      'https://therundown.io/api/v2/sports/99/events/2026-11-07',
    );
    expect(other.issues[0]).toMatchObject({ fatal: true, code: 'unknown_request' });
    expect(parse(base([]))).toMatchObject({
      stats: { recordsSeen: 0, recordsAccepted: 0 },
      marketOdds: [],
    });
  });

  it('other adapters carry an empty marketOdds', () => {
    const r = createAdapter({
      id: 's',
      adapter: 'openfootball',
      upstream: 'u',
      config: {
        allowedHosts: ['a.example.com'],
        requests: [{ url: 'https://a.example.com/x', competition: 'L' }],
        timeZone: 'Europe/London',
      },
    });
    if (!r.ok) throw new Error('config');
    expect(
      safeParse(r.adapter, { ...doc('{"matches":[]}'), url: 'https://a.example.com/x' }).marketOdds,
    ).toEqual([]);
  });
});

describe('price conversion', () => {
  it.each([
    [150, 2500],
    [100, 2000],
    [250, 3500],
    [-110, 1909],
    [-105, 1952],
    [-115, 1869],
    [-200, 1500],
    [-10000, 1010],
    ['+150', 2500],
    ['-110', 1909],
    [150.5, 2505],
    [-110.5, 1000 + Math.floor(100000 / 110.5)],
  ])('American %j is %d milli', (price, milli) => {
    expect(americanToMilli(price)).toEqual({ ok: true, milli });
  });

  it.each([
    [1.85, 1850],
    [2, 2000],
    [1.01, 1010],
    [1000, 1_000_000],
    ['3.405', 3405],
    [1.9999, 1999],
    [1.1, 1100],
    [1.001 + 0.01, 1011],
  ])('decimal %j is %d milli', (price, milli) => {
    expect(decimalToMilli(price)).toEqual({ ok: true, milli });
  });

  it.each([
    [americanToMilli, 99, 'american_range'],
    [americanToMilli, -99, 'american_range'],
    [americanToMilli, 0, 'american_range'],
    [americanToMilli, 1.85, 'american_range'],
    [americanToMilli, 100_000, 'milli_range'],
    [americanToMilli, 'abc', 'unparseable'],
    [americanToMilli, NaN, 'unparseable'],
    [americanToMilli, null, 'unparseable'],
    [americanToMilli, 1e-7, 'unparseable'],
    [americanToMilli, '1e3', 'unparseable'],
    [americanToMilli, Infinity, 'unparseable'],
    [decimalToMilli, 1.0, 'decimal_range'],
    [decimalToMilli, 1.009, 'decimal_range'],
    [decimalToMilli, 1000.01, 'decimal_range'],
    [decimalToMilli, -1.85, 'decimal_range'],
    [decimalToMilli, '', 'unparseable'],
    [decimalToMilli, undefined, 'unparseable'],
  ])('%o refuses %j (%s)', (fn, price, problem) => {
    expect(fn(price)).toEqual({ ok: false, problem });
  });

  it('reads a number through its decimal text, so 1.85 is exactly 185/100', () => {
    expect(exactDecimal(1.85)).toEqual({ n: 185n, d: 100n });
    expect(exactDecimal('-110')).toEqual({ n: -110n, d: 1n });
    expect(exactDecimal('+0.0001')).toEqual({ n: 1n, d: 10000n });
    expect(exactDecimal('1.')).toBeNull();
    expect(exactDecimal(' 12 ')).toEqual({ n: 12n, d: 1n });
  });

  // Reference: the same value by another route, in BigInt (home-grown, not the production formula).
  const referenceAmerican = (p: number): bigint | null => {
    const a = BigInt(Math.abs(p));
    if (a < 100n) return null;
    const m = p > 0 ? (1000n * (100n + a)) / 100n : (1000n * (a + 100n)) / a;
    return m >= 1010n && m <= 1_000_000n ? m : null;
  };

  it('property: American integers match the big-int reference and never round up', () => {
    fc.assert(
      fc.property(fc.integer({ min: -200_000, max: 200_000 }), (p) => {
        const got = americanToMilli(p);
        const want = referenceAmerican(p);
        if (want === null) {
          expect(got.ok).toBe(false);
          return;
        }
        expect(got).toEqual({ ok: true, milli: Number(want) });
        // rounded DOWN: the exact decimal price is at least what we return (exact rational check)
        const a = BigInt(Math.abs(p));
        const exactTimesDen = p > 0 ? 1000n * (100n + a) : 1000n * (a + 100n);
        const den = p > 0 ? 100n : a;
        expect(want * den <= exactTimesDen).toBe(true);
        expect((want + 1n) * den > exactTimesDen).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('property: American to milli is monotonic in the price a bettor gets', () => {
    // Ordering of American prices by value: -inf < ... < -100 and +100 < ... < +inf, with -100 == +100 as evens.
    const decimalOrder = (p: number) => (p > 0 ? 100 + p : 100 + 10_000 / -p);
    fc.assert(
      fc.property(
        fc
          .integer({ min: 100, max: 100_000 })
          .chain((a) => fc.tuple(fc.constant(a), fc.integer({ min: 100, max: 100_000 }))),
        fc.boolean(),
        fc.boolean(),
        ([a, b], signA, signB) => {
          const pa = signA ? a : -a;
          const pb = signB ? b : -b;
          const ma = americanToMilli(pa);
          const mb = americanToMilli(pb);
          fc.pre(ma.ok && mb.ok);
          if (!ma.ok || !mb.ok) return;
          if (decimalOrder(pa) < decimalOrder(pb)) expect(ma.milli).toBeLessThanOrEqual(mb.milli);
          if (decimalOrder(pa) > decimalOrder(pb))
            expect(ma.milli).toBeGreaterThanOrEqual(mb.milli);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('property: decimal prices with up to 4 decimals match the big-int reference and round down', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (tenThousandths) => {
        // price = tenThousandths / 10_000 exactly; milli = floor(tenThousandths / 10)
        const text = `${Math.floor(tenThousandths / 10_000)}.${String(tenThousandths % 10_000).padStart(4, '0')}`;
        const got = decimalToMilli(text);
        const inRange = tenThousandths >= 10_100 && tenThousandths <= 10_000_000;
        if (!inRange) {
          expect(got.ok).toBe(false);
          return;
        }
        expect(got).toEqual({ ok: true, milli: Math.floor(tenThousandths / 10) });
        // the number form agrees with the text form
        expect(decimalToMilli(Number(text))).toEqual(got);
      }),
      { numRuns: 2000 },
    );
  });

  it('property: it never throws and never returns a price outside 1010..1000000 or a non-integer', () => {
    fc.assert(
      fc.property(fc.anything(), fc.constantFrom('american', 'decimal'), (value, format) => {
        const r = format === 'american' ? americanToMilli(value) : decimalToMilli(value);
        if (r.ok) {
          expect(Number.isInteger(r.milli)).toBe(true);
          expect(r.milli).toBeGreaterThanOrEqual(1010);
          expect(r.milli).toBeLessThanOrEqual(1_000_000);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('therundown key redaction', () => {
  const KEY = 'k3y-4f2c9a7e1b6d0835-DO-NOT-LEAK';

  it('the adapter never holds, plans or emits a key: only the variable NAME travels', () => {
    const adapter = build();
    const plan = adapter.plan(new Date('2026-11-01T00:00:00Z'));
    const out = safeParse(adapter, doc(GOLDEN));
    for (const text of [
      JSON.stringify(plan),
      JSON.stringify(out),
      JSON.stringify(adapter.descriptor),
    ]) {
      expect(text).not.toContain(KEY);
    }
    expect(JSON.stringify(plan)).toContain('SCRAPER_SECRET_THERUNDOWN');
    // no query-string key, no Authorization header, no inline header value
    for (const item of plan) {
      expect(new URL(item.url).searchParams.has('key')).toBe(false);
      expect(item.headers).toBeUndefined();
    }
  });
});

describe('therundown hostile documents', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   \n'],
    ['not json', 'hello <b>'],
    ['events is a string', '{"events":"x"}'],
    ['deep json', '['.repeat(200_000)],
    ['deep json balanced', '['.repeat(50_000) + ']'.repeat(50_000)],
    ['null events', '{"events":[null,1,"x",[],{}]}'],
    ['6 MB', 'x'.repeat(6 * 1024 * 1024)],
  ])('%s never throws and yields consistent stats', (_name, body) => {
    const o = safeParse(build(), doc(body));
    expect(o.stats.recordsAccepted).toBeLessThanOrEqual(o.stats.recordsSeen);
    expect(o.issues.length).toBeLessThanOrEqual(MAX_ISSUES);
    expect(o.marketOdds).toEqual([]);
  });

  it('a 6 MB body is fatal with nothing in it', () => {
    const o = build().parse(doc('x'.repeat(6 * 1024 * 1024)));
    expect(o.issues[0]).toMatchObject({ fatal: true, code: 'document_too_large' });
    expect(o.fixtures.length + o.results.length + o.marketOdds.length).toBe(0);
  });

  it('caps records and issues for huge arrays', () => {
    const list = Array.from({ length: MAX_RECORDS + 500 }, () => ({ event_id: 'x' }));
    const o = build().parse(doc(JSON.stringify({ events: list })));
    expect(o.stats.recordsSeen).toBe(MAX_RECORDS);
    expect(o.stats.recordsAccepted).toBe(0);
    expect(o.issues.length).toBeLessThanOrEqual(MAX_ISSUES);
  });

  it('reads own properties only: __proto__ and constructor keys are inert', () => {
    const body =
      '{"events":[{"event_id":"e1","sport_id":11,"event_date":"2026-11-07T15:00:00Z",' +
      '"teams":[{"team_id":1,"name":"A","is_home":true,"is_away":false},{"team_id":2,"name":"B","is_home":false,"is_away":true}],' +
      '"score":{"event_status":"STATUS_SCHEDULED"},"__proto__":{"polluted":true},"constructor":{"x":1},' +
      '"markets":[{"market_id":1,"period_id":0,"participants":[{"id":1,"name":"A","lines":[{"prices":{"__proto__":{"price":150},"constructor":{"price":150}}}]}]}]}]}';
    const o = safeParse(build(), doc(body));
    expect(o.fixtures).toHaveLength(1);
    expect(o.marketOdds).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('property: arbitrary JSON and text never throws and keeps the counters consistent', () => {
    const adapter = build();
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.json()), (body) => {
        const o = adapter.parse(doc(body));
        expect(o.stats.recordsAccepted).toBeLessThanOrEqual(o.stats.recordsSeen);
        expect(o.fixtures.length + o.results.length).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});

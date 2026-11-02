import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MarketOddsObservation, RawDocument, SourceAdapter } from '../types';
import {
  createAdapter,
  safeParse,
  THEODDSAPI_AUTH_HEADER,
  theOddsApiCost,
  theOddsApiUrl,
  TheOddsApiConfigSchema,
} from './index';

/**
 * The documents are SYNTHETIC, in the shape The Odds API returned to the Phase 0 probe
 * (docs/theoddsapi-plan/README.md, section 10): an array of events, each with bookmakers, each
 * with `h2h` and `totals` markets. Rules A1 to A8 of that plan.
 */

const FETCHED_AT = new Date('2026-11-07T10:00:00Z');
const config = {
  allowedHosts: ['api.the-odds-api.com'],
  secret: 'SCRAPER_SECRET_THEODDSAPI',
  sport: 'football',
  sportKey: 'soccer_epl',
  competition: 'Premier League',
  bookmakers: ['pinnacle', 'williamhill', 'betsson'],
};
const URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(config));

function build(cfg: unknown = config): SourceAdapter {
  const r = createAdapter({
    id: 'odds-epl',
    adapter: 'theoddsapi',
    upstream: 'TheOddsAPI',
    config: cfg,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.adapter;
}
function refused(cfg: unknown): string[] {
  const r = createAdapter({ id: 's', adapter: 'theoddsapi', upstream: 'u', config: cfg });
  if (r.ok) throw new Error('expected the config to be refused');
  return r.errors;
}
const doc = (body: unknown, url = URL): RawDocument => ({
  sourceId: 'odds-epl',
  url,
  status: 200,
  contentType: 'application/json',
  body: typeof body === 'string' ? body : JSON.stringify(body),
  fetchedAt: FETCHED_AT,
  contentHash: 'h',
});
const parse = (body: unknown, cfg: unknown = config, url?: string) =>
  safeParse(build(cfg), doc(body, url));

// --- document builders ------------------------------------------------------------------------

const RECENT = '2026-11-07T09:58:00Z';
type Outcome = { name: string; price: unknown; point?: number };
const h2h = (home: unknown, draw: unknown, away: unknown, last_update = RECENT) => ({
  key: 'h2h',
  last_update,
  outcomes: [
    { name: 'Arsenal', price: home },
    { name: 'Draw', price: draw },
    { name: 'Chelsea', price: away },
  ] as Outcome[],
});
const totals = (point: number, over: unknown, under: unknown, last_update = RECENT) => ({
  key: 'totals',
  last_update,
  outcomes: [
    { name: 'Over', price: over, point },
    { name: 'Under', price: under, point },
  ] as Outcome[],
});
const book = (key: string, markets: unknown[]) => ({
  key,
  title: key,
  last_update: RECENT,
  markets,
});
const event = (bookmakers: unknown[], over: Record<string, unknown> = {}) => ({
  id: 'e1a2b3',
  sport_key: 'soccer_epl',
  sport_title: 'EPL',
  commence_time: '2026-11-07T15:00:00Z',
  home_team: 'Arsenal',
  away_team: 'Chelsea',
  bookmakers,
  ...over,
});

const odds = (rows: readonly MarketOddsObservation[]) =>
  rows.map(
    (r) =>
      `${r.bookmaker} ${r.market}${r.line === null ? '' : ` ${r.line}`} ${r.selection} ${r.priceMilli}`,
  );
const codes = (outcome: ReturnType<typeof parse>) => outcome.issues.map((i) => i.code);

// --- config -----------------------------------------------------------------------------------

describe('theoddsapi config (A1, A2)', () => {
  it('asks once per run for the listed books and markets, the key in a header', () => {
    const plan = build().plan(FETCHED_AT);
    expect(plan).toEqual([
      {
        url: 'https://api.the-odds-api.com/v4/sports/soccer_epl/odds?bookmakers=pinnacle%2Cwilliamhill%2Cbetsson&markets=h2h%2Ctotals&oddsFormat=decimal&dateFormat=iso',
        purpose: 'fixtures',
        auth: { header: THEODDSAPI_AUTH_HEADER, secret: 'SCRAPER_SECRET_THEODDSAPI' },
      },
    ]);
    // Never the query-string key, never regions.
    expect(plan[0]!.url).not.toMatch(/apiKey|regions/);
  });

  it('costs markets × regions: 2 credits for up to ten books, 1 for one market', () => {
    const parsed = TheOddsApiConfigSchema.parse(config);
    expect(theOddsApiCost(parsed)).toBe(2);
    expect(theOddsApiCost({ ...parsed, markets: ['h2h'] })).toBe(1);
  });

  it('refuses an eleventh book, a book listed twice, a foreign host and a key in the config', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `book${i}`);
    expect(refused({ ...config, bookmakers: eleven }).join()).toMatch(/bookmakers/);
    expect(refused({ ...config, bookmakers: ['pinnacle', 'pinnacle'] }).join()).toMatch(/twice/);
    expect(refused({ ...config, bookmakers: ['pinnacle'] }).join()).toMatch(/bookmakers/);
    expect(refused({ ...config, allowedHosts: ['example.com'] }).join()).toMatch(/allowedHosts/);
    expect(refused({ ...config, secret: 'abc123secretvalue' }).join()).toMatch(/NAME/);
    expect(refused({ ...config, sportKey: 'Soccer EPL' }).join()).toMatch(/sportKey/);
    expect(refused({ ...config, apiKey: 'x' }).length).toBeGreaterThan(0);
  });
});

// --- parsing ----------------------------------------------------------------------------------

describe('theoddsapi parse (A3 to A8)', () => {
  it('reads complete books into price rows: the draw by name, prices converted exactly', () => {
    const out = parse([
      event([
        book('pinnacle', [h2h(2.07, 3.5, 3.6), totals(2.75, 1.95, 1.9)]),
        book('williamhill', [h2h(2.05, 3.4, 3.5), totals(2.5, 1.952, 1.85)]),
      ]),
    ]);
    expect(out.issues).toEqual([]);
    expect(out.fixtures).toEqual([]);
    expect(out.results).toEqual([]);
    expect(odds(out.marketOdds)).toEqual([
      'pinnacle 1x2 1 2070',
      'pinnacle 1x2 X 3500',
      'pinnacle 1x2 2 3600',
      'williamhill 1x2 1 2050',
      'williamhill 1x2 X 3400',
      'williamhill 1x2 2 3500',
      // Pinnacle's 2.75 is a quarter line: left out, routinely (no warning).
      'williamhill ou 2.5 over 1952',
      'williamhill ou 2.5 under 1850',
    ]);
    const first = out.marketOdds[0]!;
    expect(first).toMatchObject({
      kind: 'market_odds',
      sourceId: 'odds-epl',
      externalRef: 'e1a2b3',
      sport: 'football',
      competition: 'Premier League',
      home: 'Arsenal',
      away: 'Chelsea',
      kickoff: new Date('2026-11-07T15:00:00Z'),
      priceUpdatedAt: new Date(RECENT),
      observedAt: FETCHED_AT,
    });
  });

  it('matches outcomes by name, in any order', () => {
    const shuffled = h2h(2.1, 3.3, 3.4);
    shuffled.outcomes.reverse();
    const out = parse([event([book('betsson', [shuffled])])]);
    expect(odds(out.marketOdds)).toEqual([
      'betsson 1x2 1 2100',
      'betsson 1x2 X 3300',
      'betsson 1x2 2 3400',
    ]);
  });

  it('drops a book without its draw, or with one side of a line', () => {
    const noDraw = h2h(2.1, 3.3, 3.4);
    noDraw.outcomes = noDraw.outcomes.filter((o) => o.name !== 'Draw');
    const oneSide = totals(2.5, 1.9, 1.9);
    oneSide.outcomes = oneSide.outcomes.slice(0, 1);
    const out = parse([event([book('betsson', [noDraw, oneSide])])]);
    expect(out.marketOdds).toEqual([]);
    expect(codes(out)).toEqual(['prices_dropped']);
    expect(out.issues[0]!.context).toMatchObject({ incompleteBooks: 2 });
  });

  it('keeps a 3.5 line and leaves out whole and quarter lines', () => {
    const out = parse([
      event([
        book('williamhill', [totals(3.5, 2.6, 1.5)]),
        book('pinnacle', [totals(3, 1.9, 1.95), totals(2.25, 1.8, 2.05)]),
      ]),
    ]);
    expect(odds(out.marketOdds)).toEqual([
      'williamhill ou 3.5 over 2600',
      'williamhill ou 3.5 under 1500',
    ]);
  });

  it('skips matches that have started and matches beyond the horizon', () => {
    const out = parse([
      event([book('betsson', [h2h(2, 3, 4)])], {
        id: 'live',
        commence_time: '2026-11-07T09:30:00Z',
      }),
      event([book('betsson', [h2h(2, 3, 4)])], {
        id: 'far',
        commence_time: '2026-12-01T15:00:00Z',
      }),
      event([book('betsson', [h2h(2, 3, 4)])], { id: 'next' }),
    ]);
    expect(new Set(out.marketOdds.map((r) => r.externalRef))).toEqual(new Set(['next']));
    expect(out.issues).toEqual([]);
    const wider = parse(
      [
        event([book('betsson', [h2h(2, 3, 4)])], {
          id: 'far',
          commence_time: '2026-12-01T15:00:00Z',
        }),
      ],
      { ...config, horizonDays: 30 },
    );
    expect(wider.marketOdds).toHaveLength(3);
  });

  it('reads only the listed books', () => {
    const out = parse([
      event([book('paddypower', [h2h(2, 3, 4)]), book('betsson', [h2h(2, 3, 4)])]),
    ]);
    expect(new Set(out.marketOdds.map((r) => r.bookmaker))).toEqual(new Set(['betsson']));
    expect(out.issues[0]!.context).toMatchObject({ bookNotListed: 1 });
  });

  it('drops a book listed twice with different prices, and keeps one listed twice the same', () => {
    const conflict = parse([
      event([book('betsson', [h2h(2, 3, 4)]), book('betsson', [h2h(2.1, 3, 4)])]),
    ]);
    expect(conflict.marketOdds).toEqual([]);
    expect(conflict.issues[0]!.context).toMatchObject({ conflictingBooks: 1 });
    const twice = parse([
      event([book('betsson', [h2h(2, 3, 4)]), book('betsson', [h2h(2, 3, 4)])]),
    ]);
    expect(twice.marketOdds).toHaveLength(3);
  });

  it('drops a stale market and one dated in the future (A7)', () => {
    const out = parse([
      event([
        book('betsson', [h2h(2, 3, 4, '2026-11-07T09:30:00Z')]), // 30 min old: over 20
        book('pinnacle', [h2h(2, 3, 4, '2026-11-07T10:10:00Z')]), // 10 min ahead
        book('williamhill', [h2h(2, 3, 4, '2026-11-07T10:03:00Z')]), // 3 min ahead: a clock skew
      ]),
    ]);
    expect(new Set(out.marketOdds.map((r) => r.bookmaker))).toEqual(new Set(['williamhill']));
    expect(out.issues[0]!.context).toMatchObject({ staleMarkets: 1, futureMarkets: 1 });
    const keepAll = parse([event([book('betsson', [h2h(2, 3, 4, '2026-11-06T09:30:00Z')])])], {
      ...config,
      maxBookAgeMinutes: null,
    });
    expect(keepAll.marketOdds).toHaveLength(3);
  });

  it('refuses the whole page when the prices are not decimal odds (A6)', () => {
    const american = Array.from({ length: 6 }, (_, i) =>
      event([book('betsson', [h2h(-150, -110, 0.5)])], { id: `e${i}` }),
    );
    const out = parse(american);
    expect(out.issues.some((i) => i.fatal && i.code === 'wrong_price_format')).toBe(true);
  });

  it('is fatal for an error answer, a non-array, bad JSON or another source’s URL', () => {
    const error = parse({
      message: 'Usage quota has been reached',
      error_code: 'OUT_OF_USAGE_CREDITS',
    });
    expect(error.issues[0]).toMatchObject({
      fatal: true,
      code: 'bad_shape',
      context: { errorCode: 'OUT_OF_USAGE_CREDITS' },
    });
    expect(parse('{not json').issues[0]).toMatchObject({ fatal: true, code: 'bad_json' });
    const other = parse(
      [event([book('betsson', [h2h(2, 3, 4)])])],
      config,
      'https://api.the-odds-api.com/v4/sports/soccer_spain_la_liga/odds?markets=h2h',
    );
    expect(other.issues[0]).toMatchObject({ fatal: true, code: 'unknown_request' });
    expect(other.marketOdds).toEqual([]);
  });

  it('drops an event of another sport key or without names or time, and keeps the rest', () => {
    const out = parse([
      event([book('betsson', [h2h(2, 3, 4)])], {
        id: 'la-liga',
        sport_key: 'soccer_spain_la_liga',
      }),
      event([book('betsson', [h2h(2, 3, 4)])], { id: 'nameless', home_team: '' }),
      event([book('betsson', [h2h(2, 3, 4)])], { id: 'timeless', commence_time: 'Saturday' }),
      event([book('betsson', [h2h(2, 3, 4)])], { id: 'good' }),
    ]);
    expect(new Set(out.marketOdds.map((r) => r.externalRef))).toEqual(new Set(['good']));
    expect(codes(out).sort()).toEqual(['bad_name', 'bad_time', 'sport_mismatch']);
  });

  it('never throws, whatever the body (property)', () => {
    const adapter = build();
    const anyJson = fc.jsonValue({ maxDepth: 6 });
    const eventish = fc.record({
      id: fc.oneof(fc.string(), fc.integer()),
      sport_key: fc.constantFrom('soccer_epl', 'x', 5),
      commence_time: fc.oneof(fc.constant('2026-11-07T15:00:00Z'), fc.string()),
      home_team: fc.oneof(fc.constant('Arsenal'), fc.string(), fc.constant(null)),
      away_team: fc.oneof(fc.constant('Chelsea'), fc.string()),
      bookmakers: fc.array(
        fc.record({
          key: fc.constantFrom('betsson', 'pinnacle', 'other', 1),
          last_update: fc.oneof(fc.constant(RECENT), fc.string()),
          markets: fc.array(
            fc.record({
              key: fc.constantFrom('h2h', 'totals', 'spreads'),
              outcomes: fc.array(
                fc.record({
                  name: fc.constantFrom('Arsenal', 'Chelsea', 'Draw', 'Over', 'Under', ''),
                  price: fc.oneof(fc.double(), fc.string(), fc.constant(null), fc.integer()),
                  point: fc.oneof(fc.double(), fc.constant(2.5), fc.constant(undefined)),
                }),
                { maxLength: 4 },
              ),
            }),
            { maxLength: 3 },
          ),
        }),
        { maxLength: 4 },
      ),
    });
    fc.assert(
      fc.property(fc.oneof(anyJson, fc.array(eventish, { maxLength: 5 })), (body) => {
        const outcome = safeParse(adapter, doc(body));
        for (const row of outcome.marketOdds) {
          expect(Number.isInteger(row.priceMilli)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

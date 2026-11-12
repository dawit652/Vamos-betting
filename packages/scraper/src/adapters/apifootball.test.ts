import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RawDocument, SourceAdapter } from '../types';
import type { SourceRow } from './registry';
import {
  ApiFootballConfigSchema,
  apiFootballUrl,
  createAdapter,
  goalsAddUp,
  parseApiFootballEvents,
  safeParse,
  sourceCapabilities,
  type GoalEvent,
} from './index';

/**
 * The golden file is SYNTHETIC: hand-written from the documented shape of API-Football v3
 * (no real response, no working key). See __fixtures__/README.md. Every event body below is
 * synthetic too.
 */
const GOLDEN = readFileSync(
  new URL('./__fixtures__/apifootball-fixtures-bydate.synthetic.json', import.meta.url),
  'utf8',
);
const FETCHED_AT = new Date('2026-11-13T13:00:00Z');
const URL_DAY = apiFootballUrl('2026-11-13');
const BASE_S = 1794571200; // 2026-11-13T12:00:00Z

const config = {
  allowedHosts: ['v3.football.api-sports.io'],
  secret: 'SCRAPER_SECRET_API_FOOTBALL',
};

function build(cfg: unknown = config): SourceAdapter {
  const r = createAdapter({
    id: 'apifootball-bydate',
    adapter: 'apifootball',
    upstream: 'u',
    config: cfg,
  });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.adapter;
}
const doc = (body: string, url = URL_DAY): RawDocument => ({
  sourceId: 'apifootball-bydate',
  url,
  status: 200,
  contentType: 'application/json',
  body,
  fetchedAt: FETCHED_AT,
  contentHash: 'h',
});
const parse = (body: string, cfg: unknown = config, url?: string) =>
  safeParse(build(cfg), doc(body, url));

interface Team {
  id?: unknown;
  name: unknown;
}
interface Item {
  fixture: { id?: unknown; date: unknown; timestamp: unknown; status: { short: unknown } };
  league: { id?: unknown; name: unknown };
  teams: { home: Team; away: Team };
  goals: unknown;
  score: { halftime: unknown };
}
type Env = Record<string, unknown> & { response: Item[] };
const golden = (): Env => JSON.parse(GOLDEN) as Env;
const byId = (env: Env, id: number) => env.response.find((i) => i.fixture.id === id)!;
const run = (env: unknown, cfg: unknown = config) => parse(JSON.stringify(env), cfg);
const codes = (o: ReturnType<typeof parse>) => o.issues.map((i) => i.code);

describe('apifootball config', () => {
  it('is licensed_api, covers the host and fills defaults', () => {
    expect(build().descriptor.kind).toBe('licensed_api');
    expect(ApiFootballConfigSchema.parse(config)).toMatchObject({ daysBack: 1, daysAhead: 2 });
    expect(build().allowedHosts).toEqual(['v3.football.api-sports.io']);
  });
  it('refuses a host list that does not cover the API, a key in the config, and a bad secret name', () => {
    const bad = (c: unknown) =>
      createAdapter({ id: 's', adapter: 'apifootball', upstream: 'u', config: c });
    expect(bad({ ...config, allowedHosts: ['example.com'] }).ok).toBe(false);
    expect(bad({ ...config, secret: 'abcdef0123456789' }).ok).toBe(false);
    expect(bad({ ...config, apiKey: 'x' }).ok).toBe(false);
    expect(bad({ ...config, daysAhead: 40 }).ok).toBe(false);
  });
  it('plans one by-date request per day with the key as a header reference only', () => {
    const plan = build().plan(new Date('2026-11-13T05:00:00Z'));
    expect(plan.map((p) => p.url)).toEqual([
      'https://v3.football.api-sports.io/fixtures?date=2026-11-12&timezone=UTC',
      'https://v3.football.api-sports.io/fixtures?date=2026-11-13&timezone=UTC',
      'https://v3.football.api-sports.io/fixtures?date=2026-11-14&timezone=UTC',
      'https://v3.football.api-sports.io/fixtures?date=2026-11-15&timezone=UTC',
    ]);
    expect(plan[0]?.auth).toEqual({
      header: 'x-apisports-key',
      secret: 'SCRAPER_SECRET_API_FOOTBALL',
    });
    expect(JSON.stringify(plan)).not.toMatch(/[0-9a-f]{16,}/);
  });
  it('has capabilities and the shipped draft source file builds', () => {
    const row: SourceRow & { enabled?: unknown } = JSON.parse(
      readFileSync(
        new URL(
          '../../../../docs/scraper-plan/data/source-apifootball-bydate.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(createAdapter(row).ok).toBe(true);
    expect(row.enabled).toBeUndefined();
    expect(sourceCapabilities(row)).toMatchObject({
      ok: true,
      capabilities: { fixtures: true, fullTime: true, halfTime: true, basis: 'per-record' },
    });
  });
});

describe('apifootball by-date parsing', () => {
  const out = parse(GOLDEN);
  const result = (ref: string) => out.results.find((r) => r.externalRef === ref);
  const fixture = (ref: string) => out.fixtures.find((r) => r.externalRef === ref);

  it('reads a normal day', () => {
    expect(out.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(out.stats.recordsSeen).toBe(14);
  });

  it('FT with fulltime equal to goals is regular_time with the half-time score', () => {
    expect(result('1001')).toMatchObject({
      status: 'finished',
      home: 'Manchester United',
      away: 'Liverpool',
      competition: 'England - Premier League [39]',
      score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      scoreBasis: 'regular_time',
    });
    expect(fixture('1001')).toBeUndefined();
  });

  it('NS, 1H and HT are scheduled fixtures with round and stable competition label', () => {
    expect(fixture('1002')).toMatchObject({
      status: 'scheduled',
      round: 'Regular Season - 12',
      competition: 'England - Premier League [39]',
    });
    expect(fixture('1003')?.status).toBe('scheduled');
    expect(fixture('1004')).toMatchObject({
      status: 'scheduled',
      competition: 'Spain - La Liga [140]',
    });
    expect(result('1002') ?? result('1003') ?? result('1004')).toBeUndefined();
  });

  it('a second league named "Premier League" gets another label', () => {
    expect(result('1013')?.competition).toBe('Egypt - Premier League [233]');
    expect(fixture('1014')?.competition).toBe('Ethiopia - Premier League [363]');
  });

  it('converts the kickoff from the timestamp (UTC), also when the date has an offset', () => {
    expect(fixture('1002')?.kickoff.toISOString()).toBe('2026-11-13T14:00:00.000Z');
    expect(fixture('1014')?.kickoff.toISOString()).toBe('2026-11-13T15:00:00.000Z');
    expect(result('1001')?.kickoff.getTime()).toBe((BASE_S - 86400) * 1000);
  });

  it('AET and PEN never get regular_time: unknown basis, the goals total, shootout excluded', () => {
    expect(result('1005')).toMatchObject({
      status: 'finished',
      scoreBasis: 'unknown',
      score: { home: 3, away: 2, htHome: 1, htAway: 1 },
    });
    expect(result('1006')).toMatchObject({
      status: 'finished',
      scoreBasis: 'unknown',
      score: { home: 1, away: 1, htHome: 0, htAway: 1 },
    });
  });

  it('PST and CANC give a fixture and a result without score; ABD an abandoned result', () => {
    expect(fixture('1007')?.status).toBe('postponed');
    expect(result('1007')).toMatchObject({ status: 'postponed', score: null });
    expect(fixture('1008')?.status).toBe('cancelled');
    expect(result('1008')).toMatchObject({ status: 'cancelled', score: null });
    expect(result('1009')).toMatchObject({ status: 'abandoned', score: null });
  });

  it('AWD and WO produce no observation at all, only a warning', () => {
    for (const ref of ['1010', '1011']) {
      expect(result(ref)).toBeUndefined();
      expect(fixture(ref)).toBeUndefined();
    }
    expect(out.issues.filter((i) => i.code === 'not_a_played_score')).toHaveLength(2);
  });

  it('FT with null scores gives no result and a warning', () => {
    expect(result('1012')).toBeUndefined();
    expect(out.issues.find((i) => i.code === 'bad_score')?.severity).toBe('warning');
  });

  it('FT whose fulltime differs from goals is reported with an unknown basis', () => {
    const env = golden();
    byId(env, 1001).goals = { home: 3, away: 1 };
    const o = run({ ...env, response: [byId(env, 1001)] });
    expect(o.results[0]).toMatchObject({ scoreBasis: 'unknown', score: { home: 2, away: 1 } });
    expect(codes(o)).toContain('score_disagrees');
  });

  it('FT with null goals but a fulltime is unknown, never regular_time', () => {
    const env = golden();
    byId(env, 1001).goals = { home: null, away: null };
    const o = run({ ...env, response: [byId(env, 1001)] });
    expect(o.results[0]?.scoreBasis).toBe('unknown');
  });

  it('drops a half-time score above the final and keeps the result', () => {
    const env = golden();
    byId(env, 1001).score.halftime = { home: 5, away: 0 };
    const o = run({ ...env, response: [byId(env, 1001)] });
    expect(o.results[0]?.score).toMatchObject({ htHome: null, htAway: null });
    expect(codes(o)).toContain('bad_half_time');
  });

  it('an AET without goals gives no result', () => {
    const env = golden();
    byId(env, 1005).goals = { home: null, away: null };
    const o = run({ ...env, response: [byId(env, 1005)] });
    expect(o.results).toEqual([]);
  });

  it('an unknown status is dropped', () => {
    const env = golden();
    byId(env, 1002).fixture.status.short = 'XYZ';
    const o = run({ ...env, response: [byId(env, 1002)] });
    expect(o.fixtures).toEqual([]);
    expect(codes(o)).toContain('unknown_status');
  });

  it('only reads the configured leagues', () => {
    const o = parse(GOLDEN, { ...config, leagueIds: [39] });
    expect(o.stats.recordsSeen).toBe(3);
    expect(o.fixtures.length + o.results.length).toBe(3);
  });
});

describe('apifootball envelope failures (breaker)', () => {
  const fatal = (o: ReturnType<typeof parse>) => o.issues.find((i) => i.fatal);
  it('an errors object (missing key) is fatal, not zero fixtures', () => {
    const o = run({
      get: 'fixtures',
      parameters: [],
      errors: {
        token:
          'Error/Missing application key. Go to https://www.api-football.com/documentation-v3 to learn how to get your API application key.',
      },
      results: 0,
      paging: { current: 1, total: 1 },
      response: [],
    });
    expect(fatal(o)).toMatchObject({ code: 'api_error', context: { errors: 'token' } });
    expect(JSON.stringify(o.issues)).not.toContain('Missing application key');
    expect(o.stats.recordsAccepted).toBe(0);
  });
  it('a non-empty errors array is fatal; an empty one or object is fine', () => {
    const env = { ...golden(), errors: ['rate limit'] };
    expect(fatal(run(env))?.code).toBe('api_error');
    expect(fatal(run({ ...golden(), errors: [] }))).toBeUndefined();
    expect(fatal(run({ ...golden(), errors: {} }))).toBeUndefined();
    expect(fatal(run({ ...golden(), errors: 'boom' }))?.code).toBe('api_error');
  });
  it('paging total above 1 is fatal (not followed)', () => {
    const env = { ...golden(), paging: { current: 1, total: 2 } };
    const o = run(env);
    expect(fatal(o)?.code).toBe('paging');
    expect(o.fixtures).toEqual([]);
    expect(fatal(run({ ...golden(), paging: { current: 1, total: 'x' } }))?.code).toBe('paging');
  });
  it('a wrong shape, wrong endpoint or wrong date is fatal', () => {
    expect(fatal(parse('not json'))?.code).toBe('bad_json');
    expect(fatal(parse('[]'))?.code).toBe('bad_shape');
    expect(fatal(run({ ...golden(), response: {} }))?.code).toBe('bad_shape');
    expect(fatal(run({ ...golden(), get: 'leagues' }))?.code).toBe('bad_shape');
    expect(fatal(run({ ...golden(), parameters: { date: '2026-11-14' } }))?.code).toBe('bad_shape');
    expect(fatal(parse(GOLDEN, config, 'https://v3.football.api-sports.io/leagues'))?.code).toBe(
      'unknown_request',
    );
  });
  it('a quiet day (empty response, no errors) is valid and yields nothing', () => {
    const o = run({ ...golden(), response: [], results: 0 });
    expect(o.issues).toEqual([]);
    expect(o.stats).toEqual({ recordsSeen: 0, recordsAccepted: 0 });
  });
});

describe('apifootball malformed items are rejected one by one', () => {
  const mutate = (fn: (item: Item) => void, id = 1002) => {
    const env = golden();
    const item = byId(env, id);
    fn(item);
    return run({ ...env, response: [item, byId(golden(), 1001)] });
  };
  it('missing fixture id, missing team id, missing league id', () => {
    for (const fn of [
      (i: Item) => delete i.fixture.id,
      (i: Item) => (i.fixture.id = '1002'),
      (i: Item) => (i.fixture.id = 0),
      (i: Item) => delete i.teams.home.id,
      (i: Item) => delete i.league.id,
    ]) {
      const o = mutate(fn);
      expect(o.fixtures).toEqual([]);
      expect(o.results).toHaveLength(1);
      expect(o.stats).toEqual({ recordsSeen: 2, recordsAccepted: 1 });
      expect(o.issues.some((i) => i.severity === 'error')).toBe(true);
    }
  });
  it('bad dates and timestamps, and a date that disagrees with the timestamp', () => {
    for (const fn of [
      (i: Item) => (i.fixture.date = 'tomorrow'),
      (i: Item) => (i.fixture.date = '2026-11-13T14:00:00'),
      (i: Item) => (i.fixture.date = '2026-02-30T14:00:00+00:00'),
      (i: Item) => (i.fixture.timestamp = null),
      (i: Item) => (i.fixture.timestamp = -5),
      (i: Item) => (i.fixture.timestamp = Number(i.fixture.timestamp) + 3600),
    ]) {
      const o = mutate(fn);
      expect(codes(o)).toContain('bad_time');
      expect(o.fixtures).toEqual([]);
    }
  });
  it('the same team twice (same id, or same name) is rejected', () => {
    expect(codes(mutate((i) => (i.teams.away.id = i.teams.home.id)))).toContain('bad_name');
    const sameName = mutate(
      (i) => (i.teams.away.name = ' ' + String(i.teams.home.name).toUpperCase()),
    );
    expect(sameName.fixtures).toEqual([]);
    expect(codes(sameName)).toContain('invalid_record');
  });
  it('missing names and non-object items', () => {
    expect(codes(mutate((i) => (i.teams.home.name = '')))).toContain('bad_name');
    expect(codes(mutate((i) => (i.league.name = null)))).toContain('bad_name');
    const o = run({ ...golden(), response: [5, null, 'x'] });
    expect(o.stats).toEqual({ recordsSeen: 3, recordsAccepted: 0 });
  });
  it('a very long league name still fits the label', () => {
    const o = mutate((i) => (i.league.name = 'L'.repeat(300)));
    expect(o.fixtures[0]?.competition.length).toBeLessThanOrEqual(120);
    expect(o.fixtures[0]?.competition.endsWith('[39]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Events

const ev = (
  elapsed: number,
  extra: number | null,
  teamId: number,
  type: string,
  detail: string,
) => ({
  time: { elapsed, extra },
  team: { id: teamId, name: `T${teamId}` },
  player: { id: 1, name: 'P' },
  assist: { id: null, name: null },
  type,
  detail,
  comments: null,
});
const events = (response: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({
    get: 'fixtures/events',
    parameters: { fixture: '1001' },
    errors: [],
    results: response.length,
    paging: { current: 1, total: 1 },
    response,
    ...over,
  });

describe('parseApiFootballEvents', () => {
  it('keeps goals, drops cards, substitutions and missed penalties', () => {
    const r = parseApiFootballEvents(
      events([
        ev(12, null, 33, 'Goal', 'Normal Goal'),
        ev(30, null, 40, 'Card', 'Yellow Card'),
        ev(44, 2, 40, 'Goal', 'Penalty'),
        ev(50, null, 33, 'subst', 'Substitution 1'),
        ev(60, null, 33, 'Goal', 'Missed Penalty'),
        ev(77, null, 33, 'Goal', 'Own Goal'),
      ]),
    );
    expect(r).toEqual({
      ok: true,
      varGoalChecks: 0,
      timeline: [
        { elapsed: 12, extra: null, teamId: 33, kind: 'goal' },
        { elapsed: 44, extra: 2, teamId: 40, kind: 'penalty' },
        { elapsed: 77, extra: null, teamId: 33, kind: 'own_goal' },
      ],
    });
  });
  it('counts VAR goal checks for a person to look at', () => {
    const r = parseApiFootballEvents(
      events([ev(12, null, 33, 'Goal', 'Normal Goal'), ev(13, null, 33, 'Var', 'Goal cancelled')]),
    );
    expect(r).toMatchObject({ ok: true, varGoalChecks: 1 });
  });
  it('accepts a parsed object too', () => {
    expect(parseApiFootballEvents(JSON.parse(events([])))).toEqual({
      ok: true,
      timeline: [],
      varGoalChecks: 0,
    });
  });
  it('fails closed on errors, paging, shape and malformed goals', () => {
    const bad = (x: unknown) => expect(parseApiFootballEvents(x)).toMatchObject({ ok: false });
    bad('nope');
    bad('[]');
    bad(events([], { errors: { token: 'x' } }));
    bad(events([], { errors: ['x'] }));
    bad(events([], { paging: { current: 1, total: 2 } }));
    bad(events([], { get: 'fixtures' }));
    bad(events([ev(12, null, 33, 'Goal', 'Mystery Goal')]));
    bad(events([{ ...ev(12, null, 33, 'Goal', 'Normal Goal'), team: {} }]));
    bad(events([{ ...ev(12, null, 33, 'Goal', 'Normal Goal'), time: { elapsed: null } }]));
    bad(events(['x']));
  });
});

describe('goalsAddUp', () => {
  const H = 33;
  const A = 40;
  const goal = (
    elapsed: number,
    teamId: number,
    kind: GoalEvent['kind'] = 'goal',
    extra: number | null = null,
  ): GoalEvent => ({
    elapsed,
    extra,
    teamId,
    kind,
  });
  const score = { home: 2, away: 1, htHome: 1, htAway: 0 };
  const timeline = [goal(12, H), goal(55, A), goal(88, H)];

  it('adds up regular time and the half-time score', () => {
    expect(goalsAddUp(timeline, H, A, score, 'credited_team')).toMatchObject({
      matches: true,
      fullTimeMatches: true,
      halfTimeMatches: true,
      counted: { home: 2, away: 1 },
      countedFirstHalf: { home: 1, away: 0 },
    });
  });
  it('90+ added time counts, extra time and the shootout do not', () => {
    const t = [...timeline, goal(90, A, 'goal', 4), goal(105, H), goal(120, H, 'penalty')];
    expect(goalsAddUp(t, H, A, { home: 2, away: 2 }, 'credited_team').counted).toEqual({
      home: 2,
      away: 2,
    });
    expect(goalsAddUp(t, H, A, { home: 2, away: 2 }, 'credited_team').matches).toBe(true);
    expect(goalsAddUp(t, H, A, { home: 3, away: 2 }, 'credited_team', 120).fullTimeMatches).toBe(
      false,
    );
  });
  it('first-half added time (45+2) is first half', () => {
    const t = [goal(45, H, 'goal', 2), goal(46, A)];
    const r = goalsAddUp(t, H, A, { home: 1, away: 1, htHome: 1, htAway: 0 }, 'credited_team');
    expect(r.matches).toBe(true);
    expect(r.countedFirstHalf).toEqual({ home: 1, away: 0 });
  });
  it('a wrong half-time score or total does not match; a missing half-time score is not checked', () => {
    expect(
      goalsAddUp(timeline, H, A, { ...score, htHome: 0, htAway: 0 }, 'credited_team'),
    ).toMatchObject({
      matches: false,
      fullTimeMatches: true,
      halfTimeMatches: false,
    });
    expect(goalsAddUp(timeline, H, A, { home: 3, away: 1 }, 'credited_team').matches).toBe(false);
    expect(goalsAddUp(timeline, H, A, { home: 2, away: 1 }, 'credited_team')).toMatchObject({
      matches: true,
      halfTimeMatches: null,
    });
  });
  it('own goals follow the explicit rule, both ways', () => {
    // An own goal in minute 30 whose event team is the home team.
    const t = [goal(30, H, 'own_goal')];
    const credited = goalsAddUp(
      t,
      H,
      A,
      { home: 1, away: 0, htHome: 1, htAway: 0 },
      'credited_team',
    );
    expect(credited.matches).toBe(true);
    const scorer = goalsAddUp(t, H, A, { home: 1, away: 0, htHome: 1, htAway: 0 }, 'scorer_team');
    expect(scorer.matches).toBe(false);
    expect(scorer.counted).toEqual({ home: 0, away: 1 });
    expect(
      goalsAddUp(t, H, A, { home: 0, away: 1, htHome: 0, htAway: 1 }, 'scorer_team').matches,
    ).toBe(true);
    // A normal goal ignores the rule.
    expect(goalsAddUp([goal(5, H)], H, A, { home: 1, away: 0 }, 'scorer_team').matches).toBe(true);
  });
  it('a goal of a third team fails the check', () => {
    const r = goalsAddUp([goal(5, 99)], H, A, { home: 0, away: 0 }, 'credited_team');
    expect(r.matches).toBe(false);
    expect(r.reason).toBeDefined();
  });
  it('0-0 with no goals matches', () => {
    expect(
      goalsAddUp([], H, A, { home: 0, away: 0, htHome: 0, htAway: 0 }, 'credited_team').matches,
    ).toBe(true);
  });
});

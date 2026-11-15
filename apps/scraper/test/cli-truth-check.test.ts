import { setSourceEnabled, startRun, upsertObservation, upsertSource, writeAudit } from '@vamos/db';
import { competitions, events, teams } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seasonStart } from '../src/eval/truth-check';
import { catalogDatabase, cliHarness, OPENFOOTBALL_SOURCE } from './cli-helpers';
import { HOUR, SETUP_TIMEOUT, T0 } from './helpers';

let db: Awaited<ReturnType<typeof catalogDatabase>>;
let cli: ReturnType<typeof cliHarness>;
const DAY = 24 * HOUR;
const SYSTEM = { system: 'system:test' } as const;

type Score = { home: number; away: number; htHome: number | null; htAway: number | null };
const ft = (home: number, away: number, ht: [number, number] | null = null): Score => ({
  home,
  away,
  htHome: ht?.[0] ?? null,
  htAway: ht?.[1] ?? null,
});

interface TruthJson {
  since: string;
  written: boolean;
  upstreams: {
    upstream: string;
    compared: number;
    agreed: number;
    rate: number | null;
    trust: string;
    ownVote: number;
    unrecorded: number;
    independentCompared: number;
    independentAgreed: number;
    disagreements: {
      eventId: string;
      sourceId: string;
      observed: Score;
      applied: Score;
    }[];
  }[];
}
const truth = async (...args: string[]): Promise<TruthJson> => {
  const run = await cli.run('sources', 'truth-check', '--json', ...args);
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as TruthJson;
};
const stored = async () =>
  (
    await db.pool.query<{
      upstream: string;
      compared: number;
      agreed: number;
      disagreements: { eventId: string }[];
      measured_at: Date;
      window_from: Date | null;
    }>(
      `SELECT upstream, compared, agreed, disagreements, measured_at, window_from
         FROM scrape_source_trust ORDER BY upstream`,
    )
  ).rows;

const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await catalogDatabase();
  cli = cliHarness({ db: db.db });
  const [home, away] = await db.db.select({ id: teams.id }).from(teams).limit(2);
  const [comp] = await db.db
    .select({ id: competitions.id })
    .from(competitions)
    .where(eq(competitions.sportId, 'football'))
    .limit(1);
  if (home === undefined || away === undefined || comp === undefined)
    throw new Error('no catalogue');

  const runs = new Map<string, string>();
  // up-a: one source; up-b: two sources; up-c: a source that is switched off.
  for (const [id, upstream, enabled] of [
    ['tc-a', 'up-a', true],
    ['tc-b1', 'Up-B ', true],
    ['tc-b2', 'up-b', true],
    ['tc-c', 'up-c', false],
  ] as const) {
    await db.db.transaction(async (tx) => {
      await upsertSource(
        tx,
        { ...OPENFOOTBALL_SOURCE, adapter: 'openfootball', id, upstream },
        SYSTEM,
      );
      await setSourceEnabled(tx, id, enabled, SYSTEM);
    });
    runs.set(id, (await startRun(db.db, { sourceId: id, startedAt: T0 })).id);
  }

  let n = 0;
  const make = async (
    kickoffAgoDays: number,
    result: { status: 'finished' | 'cancelled'; score?: Score },
  ) => {
    n += 1;
    const startTime = new Date(T0.getTime() - kickoffAgoDays * DAY);
    const [row] = await db.db
      .insert(events)
      .values({
        gameId: 992_000 + n,
        sportId: 'football',
        competitionId: comp.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        startTime,
        status: result.status,
        feedProvider: 'scraped',
        feedRef: `truth-test-${n}`,
        scoreHome: result.score?.home ?? null,
        scoreAway: result.score?.away ?? null,
        htScoreHome: result.score?.htHome ?? null,
        htScoreAway: result.score?.htAway ?? null,
        resultedAt: new Date(startTime.getTime() + 3 * HOUR),
      })
      .returning({ id: events.id });
    return { eventId: row!.id, startTime };
  };
  const observe = async (
    source: string,
    at: { startTime: Date },
    score: Score,
    basis: 'regular_time' | 'includes_extra_time' = 'regular_time',
  ) => {
    await db.db.transaction((tx) =>
      upsertObservation(tx, {
        sourceId: source,
        kind: 'result',
        sourceKey: `k${at.startTime.getTime()}`,
        sport: 'football',
        competitionRaw: 'x',
        homeRaw: 'h',
        awayRaw: 'a',
        kickoff: at.startTime,
        status: 'finished',
        score,
        scoreBasis: basis,
        observedAt: T0,
        runId: runs.get(source) as string,
        competitionId: comp.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
      }),
    );
  };

  // e1: applied 2-1 (HT 1-0), applied on up-a's vote. up-b's second source has another half time.
  const e1 = await make(5, { status: 'finished', score: ft(2, 1, [1, 0]) });
  await observe('tc-a', e1, ft(2, 1, [1, 0]));
  await observe('tc-b1', e1, ft(2, 1, [1, 0]));
  await observe('tc-b2', e1, ft(2, 1, [0, 0]));
  await db.db.transaction((tx) =>
    writeAudit(tx, {
      actorType: 'system',
      actorId: 'scraper',
      action: 'scrape.result.applied',
      targetType: 'event',
      targetId: e1.eventId,
      metadata: { upstreams: ['up-a', 'up-c'] },
    }),
  );
  // e2: applied 1-0 with no half time: a half time is compared only when both have one.
  const e2 = await make(4, { status: 'finished', score: ft(1, 0) });
  await observe('tc-a', e2, ft(1, 0, [0, 0]));
  await observe('tc-b1', e2, ft(1, 0));
  // e3: up-a has another full-time score.
  const e3 = await make(3, { status: 'finished', score: ft(3, 0, [1, 0]) });
  await observe('tc-a', e3, ft(3, 1, [1, 0]));
  await observe('tc-b2', e3, ft(3, 0, [1, 0]));
  // e4: before the season; e5: not finished; e6: an extra-time score is not compared.
  const e4 = await make(200, { status: 'finished', score: ft(0, 0) });
  await observe('tc-a', e4, ft(5, 5));
  const e5 = await make(2, { status: 'cancelled' });
  await observe('tc-a', e5, ft(1, 1));
  const e6 = await make(1, { status: 'finished', score: ft(1, 1) });
  await observe('tc-a', e6, ft(2, 1), 'includes_extra_time');
  // up-c's source is switched off but its old observation still counts.
  await observe('tc-c', e1, ft(2, 1, [1, 0]));
  ids.e1 = e1.eventId;
  ids.e3 = e3.eventId;
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

describe('sources truth-check', () => {
  it('compares each upstream with the applied results, one comparison per event', async () => {
    const out = await truth();
    expect(out.written).toBe(false);
    expect(out.since).toBe('2026-07-01T00:00:00.000Z');
    const by = new Map(out.upstreams.map((u) => [u.upstream, u]));
    // Spellings of one upstream are one upstream (upstreamKey); sources of it are one vote.
    expect([...by.keys()]).toEqual(['up-a', 'up-b', 'up-c']);

    expect(by.get('up-a')).toMatchObject({ compared: 3, agreed: 2, trust: 'untrusted' });
    expect(by.get('up-a')?.rate).toBeCloseTo(2 / 3, 10);
    expect(by.get('up-a')?.disagreements).toEqual([
      expect.objectContaining({
        eventId: ids.e3,
        sourceId: 'tc-a',
        observed: ft(3, 1, [1, 0]),
        applied: ft(3, 0, [1, 0]),
      }),
    ]);
    // e1 disagrees for up-b because one of its two sources has another half-time score.
    expect(by.get('up-b')).toMatchObject({ compared: 3, agreed: 2 });
    expect(by.get('up-b')?.disagreements).toEqual([
      expect.objectContaining({ eventId: ids.e1, sourceId: 'tc-b2', observed: ft(2, 1, [0, 0]) }),
    ]);
    // A switched-off source is still measured.
    expect(by.get('up-c')).toMatchObject({ compared: 1, agreed: 1 });
  });

  it('counts the events that were applied on the upstream own vote (the circularity)', async () => {
    const by = new Map((await truth()).upstreams.map((u) => [u.upstream, u]));
    // e1 recorded up-a and up-c among its votes; e2 and e3 have no audit row.
    expect(by.get('up-a')).toMatchObject({
      ownVote: 1,
      unrecorded: 2,
      independentCompared: 2,
      independentAgreed: 1,
    });
    expect(by.get('up-b')).toMatchObject({ ownVote: 0, unrecorded: 2, independentCompared: 3 });
    expect(by.get('up-c')).toMatchObject({ ownVote: 1, independentCompared: 0 });

    const text = (await cli.run('sources', 'truth-check')).stdout;
    expect(text).toContain('Partly circular');
    expect(text).toMatch(/^up-a\s+3\s+2\s+66\.67%\s+untrusted\s+1\s+2\s+50\.00%$/m);
    expect(text).toContain('nothing stored');
  });

  it('--since and --upstream narrow the check', async () => {
    const since = await truth('--since', '2026-10-26');
    // Only e3 (3 days before T0), e5 and e6 are on or after 26 October; e6 has no comparable score.
    expect(since.upstreams.map((u) => [u.upstream, u.compared])).toEqual([
      ['up-a', 1],
      ['up-b', 1],
      ['up-c', 0],
    ]);
    const one = await truth('--upstream', ' UP-B');
    expect(one.upstreams.map((u) => u.upstream)).toEqual(['up-b']);
  });

  it('writes nothing without --write and one row per upstream with it', async () => {
    expect(await stored()).toEqual([]);
    expect((await truth('--write')).written).toBe(true);
    const rows = await stored();
    expect(rows.map((r) => [r.upstream, r.compared, r.agreed])).toEqual([
      ['up-a', 3, 2],
      ['up-b', 3, 2],
      ['up-c', 1, 1],
    ]);
    expect(rows[0]?.disagreements).toEqual([expect.objectContaining({ eventId: ids.e3 })]);
    expect(rows[0]?.measured_at).toEqual(T0);
    expect(rows[0]?.window_from).toEqual(new Date(T0.getTime() - 5 * DAY));

    // A second run replaces the rows instead of adding to them; --upstream touches only its own.
    await truth('--write', '--upstream', 'up-a', '--since', '2026-10-26');
    const again = await stored();
    expect(again.map((r) => [r.upstream, r.compared])).toEqual([
      ['up-a', 1],
      ['up-b', 3],
      ['up-c', 1],
    ]);
  });

  it('refuses an unknown upstream and a bad date', async () => {
    const unknown = await cli.run('sources', 'truth-check', '--upstream', 'nobody');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no source has the upstream "nobody"');
    expect(unknown.stderr).toContain('known upstreams: up-a, up-b, up-c');
    for (const since of ['2026-7-1', '2026-02-30', 'yesterday']) {
      expect((await cli.run('sources', 'truth-check', '--since', since)).code).toBe(2);
    }
    expect((await cli.run('sources', 'truth-check', 'extra')).code).toBe(2);
  });
});

describe('seasonStart', () => {
  it('is 1 July of this year from July on, and of last year before', () => {
    expect(seasonStart(new Date('2026-11-12T10:00:00Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(seasonStart(new Date('2026-07-01T00:00:00Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(seasonStart(new Date('2027-03-05T10:00:00Z')).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(seasonStart(new Date('2026-06-30T23:59:59Z')).toISOString()).toBe(
      '2025-07-01T00:00:00.000Z',
    );
  });
});

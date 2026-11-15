import { setSourceEnabled, startRun, upsertObservation, upsertSource } from '@vamos/db';
import { competitions, events, teams } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness, OPENFOOTBALL_SOURCE } from './cli-helpers';
import { HOUR, MINUTE, SETUP_TIMEOUT, T0 } from './helpers';

let db: Awaited<ReturnType<typeof catalogDatabase>>;
let cli: ReturnType<typeof cliHarness>;
const DAY = 24 * HOUR;
const SYSTEM = { system: 'system:test' } as const;

interface Audit {
  assumedMatchMinutes: number;
  overall: { count: number; mismatches: number; medianLatencyMinutes: number | null };
  byCompetition: {
    competition: string;
    count: number;
    mismatches: number;
    medianLatencyMinutes: number | null;
    p90LatencyMinutes: number | null;
    meetsTargets: boolean | null;
  }[];
  events: {
    gameId: number;
    latencyMinutes: number;
    sources: { sourceId: string; verdict: string }[];
  }[];
}

beforeAll(async () => {
  db = await catalogDatabase();
  cli = cliHarness({ db: db.db });
  const [home, away] = await db.db.select({ id: teams.id }).from(teams).limit(2);
  const comps = await db.db
    .select({ id: competitions.id, slug: competitions.slug })
    .from(competitions)
    .where(eq(competitions.sportId, 'football'))
    .limit(2);
  const [compA, compB] = comps;
  if (home === undefined || away === undefined || compA === undefined || compB === undefined) {
    throw new Error('no catalogue');
  }
  const runs = new Map<string, string>();
  for (const [id, upstream] of [
    ['audit-a', 'up-a'],
    ['audit-fd', 'football-data.org'],
  ] as const) {
    await db.db.transaction(async (tx) => {
      await upsertSource(
        tx,
        { ...OPENFOOTBALL_SOURCE, adapter: 'openfootball', id, upstream },
        SYSTEM,
      );
      await setSourceEnabled(tx, id, true, SYSTEM);
    });
    runs.set(id, (await startRun(db.db, { sourceId: id, startedAt: T0 })).id);
  }

  const make = async (
    n: number,
    competition: string,
    kickoffAgoMs: number,
    appliedAfterWhistleMin: number,
    score: [number, number, number, number],
  ) => {
    const startTime = new Date(T0.getTime() - kickoffAgoMs);
    await db.db.insert(events).values({
      gameId: 991_000 + n,
      sportId: 'football',
      competitionId: competition,
      homeTeamId: home.id,
      awayTeamId: away.id,
      startTime,
      status: 'finished',
      feedProvider: 'scraped',
      feedRef: `audit-test-${n}`,
      scoreHome: score[0],
      scoreAway: score[1],
      htScoreHome: score[2],
      htScoreAway: score[3],
      resultedAt: new Date(startTime.getTime() + (105 + appliedAfterWhistleMin) * MINUTE),
    });
    return startTime;
  };
  const observe = async (
    source: string,
    key: string,
    competition: string,
    kickoff: Date,
    score: { home: number; away: number; htHome: number | null; htAway: number | null },
  ) => {
    await db.db.transaction((tx) =>
      upsertObservation(tx, {
        sourceId: source,
        kind: 'result',
        sourceKey: key,
        sport: 'football',
        competitionRaw: 'x',
        homeRaw: 'h',
        awayRaw: 'a',
        kickoff,
        status: 'finished',
        score,
        scoreBasis: 'regular_time',
        observedAt: T0,
        runId: runs.get(source) as string,
        competitionId: competition,
        homeTeamId: home.id,
        awayTeamId: away.id,
      }),
    );
  };

  // Game 1 (A): applied 10 min after the whistle; the second source has another half-time score.
  const k1 = await make(1, compA.id, 5 * DAY, 10, [2, 1, 1, 0]);
  await observe('audit-a', 'g1', compA.id, k1, { home: 2, away: 1, htHome: 1, htAway: 0 });
  await observe('audit-fd', 'g1', compA.id, k1, { home: 2, away: 1, htHome: 0, htAway: 0 });
  // Game 2 (A): applied 30 min after; a source has another full-time score.
  const k2 = await make(2, compA.id, 4 * DAY + 3 * HOUR, 30, [1, 0, 0, 0]);
  await observe('audit-a', 'g2', compA.id, k2, { home: 1, away: 1, htHome: null, htAway: null });
  // Game 3 (A): applied less than 48 h ago, so not audited yet.
  await make(3, compA.id, 2 * HOUR + 105 * MINUTE, 5, [3, 3, 1, 1]);
  // Game 4 (B): applied 20 min after, every source agrees.
  const k4 = await make(4, compB.id, 6 * DAY, 20, [0, 0, 0, 0]);
  await observe('audit-a', 'g4', compB.id, k4, { home: 0, away: 0, htHome: 0, htAway: 0 });
  await observe('audit-fd', 'g4', compB.id, k4, { home: 0, away: 0, htHome: null, htAway: null });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

describe('review results-audit', () => {
  it('--json audits results applied at least 48 h ago and flags the sources that differ', async () => {
    const run = await cli.run('review', 'results-audit', '--json');
    expect(run.code).toBe(0);
    const audit = JSON.parse(run.stdout) as Audit;
    expect(audit.assumedMatchMinutes).toBe(105);
    expect(audit.overall).toMatchObject({ count: 3, mismatches: 2 });

    const byGame = new Map(audit.events.map((e) => [e.gameId, e]));
    expect([...byGame.keys()].sort()).toEqual([991_001, 991_002, 991_004]);
    expect(byGame.get(991_001)?.latencyMinutes).toBeCloseTo(10, 6);
    expect(byGame.get(991_001)?.sources).toEqual([
      expect.objectContaining({ sourceId: 'audit-a', verdict: 'match' }),
      expect.objectContaining({ sourceId: 'audit-fd', verdict: 'ht' }),
    ]);
    expect(byGame.get(991_002)?.sources).toEqual([
      expect.objectContaining({ sourceId: 'audit-a', verdict: 'ft' }),
    ]);
    expect(byGame.get(991_004)?.sources.map((s) => s.verdict)).toEqual(['match', 'match']);

    const groups = audit.byCompetition;
    expect(groups).toHaveLength(2);
    const twoGames = groups.find((g) => g.count === 2);
    expect(twoGames).toMatchObject({
      mismatches: 2,
      medianLatencyMinutes: 20,
      p90LatencyMinutes: 30,
      meetsTargets: true,
    });
    expect(groups.find((g) => g.count === 1)).toMatchObject({
      mismatches: 0,
      medianLatencyMinutes: 20,
      p90LatencyMinutes: 20,
    });
  });

  it('prints a summary table and the mismatching results', async () => {
    const run = await cli.run('review', 'results-audit', '--days', '30');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('kickoff + 105 min');
    expect(run.stdout).toMatch(/^all\s+3\s+2\s+20\.0\s+30\.0\s+yes$/m);
    expect(run.stdout).toContain('2 result(s) with a source that disagrees');
    expect(run.stdout).toMatch(/audit-fd\s+football-data\.org\s+ht\s+2-1 \(HT 0-0\)/);
  });

  it('a window with no applied results is empty, and bad flags are a usage error', async () => {
    const run = await cli.run('review', 'results-audit', '--days', '1');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('No mismatches.');
    for (const args of [['--days', '0'], ['--days', '91'], ['--days', 'x'], ['extra']]) {
      expect((await cli.run('review', 'results-audit', ...args)).code).toBe(2);
    }
  });
});

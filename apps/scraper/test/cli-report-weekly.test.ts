import { setCompetitionPolicy } from '@vamos/db';
import { auditLog, competitions, events, markets, selections, teams } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { MINUTE, SETUP_TIMEOUT } from './helpers';

/** `report weekly` on a seeded database; the CLI clock is 2026-10-29, so the default week is 2026-W43. */

let db: Awaited<ReturnType<typeof catalogDatabase>>;
let cli: ReturnType<typeof cliHarness>;

interface Report {
  week: { id: string; from: string; to: string };
  summary: { pass: number; fail: number; unknown: number };
  measures: { id: string; value: string | null; mark: string; note: string }[];
}

beforeAll(async () => {
  db = await catalogDatabase();
  cli = cliHarness({ db: db.db });
  const [home, away] = await db.db.select({ id: teams.id }).from(teams).limit(2);
  const [compA, compB] = await db.db
    .select({ id: competitions.id })
    .from(competitions)
    .where(eq(competitions.sportId, 'football'))
    .limit(2);
  if (home === undefined || away === undefined || compA === undefined || compB === undefined) {
    throw new Error('no catalogue');
  }
  await db.db.transaction((tx) =>
    setCompetitionPolicy(tx, compA.id, { factoryMarkets: true }, { system: 'test' }),
  );
  const kickoff = (day: number) => new Date(Date.UTC(2026, 9, day, 15));
  const make = async (
    n: number,
    competitionId: string,
    day: number,
    status: 'finished' | 'cancelled' | 'scheduled',
    appliedAfterWhistleMin: number | null,
  ) => {
    const startTime = kickoff(day);
    const [row] = await db.db
      .insert(events)
      .values({
        gameId: 992_000 + n,
        sportId: 'football',
        competitionId,
        homeTeamId: home.id,
        awayTeamId: away.id,
        startTime,
        status,
        feedProvider: 'scraped',
        feedRef: `weekly-test-${n}`,
        ...(status === 'finished'
          ? { scoreHome: 2, scoreAway: 1, htScoreHome: 1, htScoreAway: 0 }
          : {}),
        ...(appliedAfterWhistleMin === null
          ? {}
          : {
              resultedAt: new Date(startTime.getTime() + (105 + appliedAfterWhistleMin) * MINUTE),
            }),
      })
      .returning({ id: events.id });
    return row!.id;
  };
  // Applied by the result gate 10 minutes after the whistle (an audit row), with factory markets.
  const gated = await make(1, compA.id, 20, 'finished', 10);
  await db.db.insert(auditLog).values({
    actorType: 'system',
    action: 'scrape.result.applied',
    targetType: 'event',
    targetId: gated,
    metadata: { upstreams: ['openfootball'] },
  });
  const [market] = await db.db
    .insert(markets)
    .values({ eventId: gated, type: '1x2', key: '1x2' })
    .returning({ id: markets.id });
  await db.db
    .insert(selections)
    .values(['1', 'X', '2'].map((code) => ({ marketId: market!.id, code, oddsMilli: 2000 })));
  // Entered by hand, 75 minutes after the whistle.
  await make(2, compB.id, 21, 'finished', 75);
  await make(3, compA.id, 22, 'cancelled', null);
  // Never resulted, though 48 hours are over.
  await make(4, compB.id, 23, 'scheduled', null);
  // Another week: not counted.
  await make(5, compB.id, 27, 'scheduled', null);
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

describe('report weekly', () => {
  it('--json answers the measures of a week from the database', async () => {
    const run = await cli.run('report', 'weekly', '--week', '2026-W43', '--json');
    expect(run.code).toBe(0);
    const report = JSON.parse(run.stdout) as Report;
    expect(report.week).toEqual({
      id: '2026-W43',
      from: '2026-10-19T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
    });
    const m = new Map(report.measures.map((x) => [x.id, x]));
    expect(m.get('competitions')).toMatchObject({ value: '2', mark: 'fail' });
    expect(m.get('matches_listed')).toMatchObject({ value: '3', mark: 'fail' });
    expect(m.get('options_typical')).toMatchObject({ value: '3', mark: 'fail' });
    expect(m.get('review_waiting')).toMatchObject({ value: '0', mark: 'pass' });
    expect(m.get('rung_a_share')).toMatchObject({ value: '50.0%', mark: 'fail' });
    expect(m.get('whistle_to_settled')).toMatchObject({ value: '42.5 min', mark: 'fail' });
    expect(m.get('settled_48h')).toMatchObject({ value: '75.0%', mark: 'fail' });
    expect(m.get('wrong_results')).toMatchObject({ value: '0 of 2', mark: 'pass' });
    expect(m.get('pinnacle_1x2')).toMatchObject({ value: null, mark: 'unknown' });
    expect(m.get('price_above_best')).toMatchObject({ value: null, mark: 'unknown' });
    expect(m.get('ladder_shadow')).toMatchObject({ mark: 'unknown' });
    expect(m.get('feed_cost')).toMatchObject({ mark: 'unknown' });
    const { pass, fail, unknown } = report.summary;
    expect(pass + fail + unknown).toBe(report.measures.length);
  });

  it('prints the Markdown report, for the last complete week without --week', async () => {
    const run = await cli.run('report', 'weekly');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('# Weekly report 2026-W43');
    expect(run.stdout).toContain('| Measure | Target | This week | Mark | Note |');
    expect(run.stdout).toContain('| Review items waiting for a person | 0 | 0 | PASS |');
  });

  it('refuses a week that is not an ISO week', async () => {
    const run = await cli.run('report', 'weekly', '--week', '2026-44');
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--week must be an ISO week');
    expect((await cli.run('report')).stderr).toContain('"report" needs a sub-command');
  });
});

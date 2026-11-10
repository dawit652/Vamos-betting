import { finishRun, setSourceEnabled, startRun, upsertSource } from '@vamos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { cliHarness } from './cli-helpers';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  HOUR,
  jsonDoc,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  T0,
  type Harness,
} from './helpers';

const SECRET = 'SCRAPER_SECRET_THEODDSAPI';
const actor = { system: 'test' };
const BASE = {
  allowedHosts: ['api.the-odds-api.com'],
  secret: SECRET,
  sport: 'football',
  sportKey: 'soccer_epl',
  competition: 'Premier League',
};

let h: Harness;
let cli: ReturnType<typeof cliHarness>;
beforeAll(async () => {
  h = await createHarness();
  // One scraped Premier League match, 99 hours after the CLI's clock.
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  await h.ctx.db.transaction(async (tx) => {
    await setSourceEnabled(tx, 'src-a', false, actor);
    await setSourceEnabled(tx, 'src-b', false, actor);
    await upsertSource(
      tx,
      {
        id: 'odds-epl',
        name: 'odds',
        adapter: 'theoddsapi',
        upstream: 'TheOddsAPI',
        config: { ...BASE, fixtures: true, bookmakers: ['pinnacle', 'williamhill'] },
      },
      actor,
    );
    await upsertSource(
      tx,
      {
        id: 'scores-epl',
        name: 'scores',
        adapter: 'theoddsapi',
        upstream: 'TheOddsAPI',
        config: { ...BASE, mode: 'scores', daysFrom: 1, scoreBasis: 'regular_time' },
      },
      actor,
    );
    await upsertSource(
      tx,
      {
        id: 'odds-off',
        name: 'odds, switched off',
        adapter: 'theoddsapi',
        upstream: 'TheOddsAPI',
        config: { ...BASE, bookmakers: ['pinnacle', 'williamhill'] },
      },
      actor,
    );
    await setSourceEnabled(tx, 'odds-epl', true, actor);
    await setSourceEnabled(tx, 'scores-epl', true, actor);
    // Three recorded reads: one older than 24 h, two within it (used + remaining = 20 000).
    for (const [hoursAgo, used] of [
      [30, 96],
      [2, 98],
      [1, 100],
    ] as const) {
      const startedAt = new Date(T0.getTime() - hoursAgo * HOUR);
      const run = await startRun(tx, { sourceId: 'odds-epl', startedAt });
      await finishRun(tx, run.id, {
        status: 'ok',
        finishedAt: new Date(startedAt.getTime() + 1000),
        apiCredits: { spent: 2, used, remaining: 20_000 - used },
      });
    }
  });
  cli = cliHarness({ db: h.ctx.db });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

describe('sources budget', () => {
  it(
    'estimates credits a day per source from the schedule and the calendar, against the key',
    async () => {
      const run = await cli.run('sources', 'budget', '--json');
      expect(run.code).toBe(0);
      const json = JSON.parse(run.stdout) as {
        resetsOn: string;
        calendarSpanDays: number;
        disabledMeteredSources: number;
        sources: Array<{
          sourceId: string;
          competition: string;
          mode: string;
          costPerRead: number;
          matches: number;
          creditsPerDay: number;
          readsPerDay: number;
        }>;
        keys: Array<Record<string, unknown>>;
        assumptions: string[];
      };
      expect(json.resetsOn).toBe('2026-11-01');
      expect(json.calendarSpanDays).toBe(5); // the one match is 4.1 days ahead
      expect(json.disabledMeteredSources).toBe(1);
      expect(json.assumptions.length).toBeGreaterThan(3);
      const byId = new Map(json.sources.map((s) => [s.sourceId, s]));
      expect([...byId.keys()].sort()).toEqual(['odds-epl', 'scores-epl']);
      // Odds: reads every 2 h (38), every 30 min inside 24 h (40), every 10 min inside 3 h (18)
      // = 96 reads of 2 credits over the 5 days of the calendar.
      expect(byId.get('odds-epl')).toMatchObject({
        competition: 'premier-league',
        mode: 'odds',
        costPerRead: 2,
        matches: 1,
        readsPerDay: 96 / 5,
        creditsPerDay: 192 / 5,
      });
      // Scores: every 20 min from kickoff + 110 min to kickoff + 4 h = 7 reads of 2 credits.
      expect(byId.get('scores-epl')).toMatchObject({
        mode: 'scores',
        costPerRead: 2,
        creditsPerDay: 14 / 5,
      });
      expect(json.keys).toHaveLength(1);
      expect(json.keys[0]).toMatchObject({
        creditKey: SECRET,
        sources: ['odds-epl', 'scores-epl'],
        quota: 20_000,
        quotaFromReading: true,
        remaining: 19_900,
        spentLast24h: 4,
        spentMonthToDate: 6,
        guardMode: 'normal',
        daysUntilLeavesNormal: null,
        modeThen: null,
      });
      expect(json.keys[0]!.estimatedCreditsPerDay as number).toBeCloseTo(206 / 5, 6);
      // 2.5 days to the 1st: 6 + 41.2 x 2.5 = 109.
      expect(json.keys[0]!.estimatedMonthEndSpend as number).toBeCloseTo(109, 6);
    },
    TEST_TIMEOUT,
  );

  it(
    'prints the tables with the reset date and the assumptions in the footer',
    async () => {
      const run = await cli.run('sources', 'budget');
      expect(run.code).toBe(0);
      expect(run.stdout).toContain('odds-epl');
      expect(run.stdout).toMatch(/premier-league\s+odds\s+2\s+1\s+19\.2\s+38\.4/);
      expect(run.stdout).toContain(SECRET);
      expect(run.stdout).toContain('quota resets 2026-11-01');
      expect(run.stdout).toContain('1 disabled Odds API source(s) not counted.');
      expect(run.stdout).toContain('assumptions:');
      expect(run.stdout).toContain('not before reset');
    },
    TEST_TIMEOUT,
  );

  it('takes no arguments', async () => {
    expect((await cli.run('sources', 'budget', 'x')).code).toBe(2);
  });
});

import { finishRun, setSourceEnabled, startRun, upsertSource } from '@vamos/db';
import { theOddsApiUrl, TheOddsApiConfigSchema } from '@vamos/scraper';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { runDueSources } from '../src/tasks/scheduler';
import {
  createHarness,
  HOUR,
  MINUTE,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type Harness,
  type HarnessOptions,
} from './helpers';

/**
 * C-2 of docs/feed-quality-plan.md: tiered polling. Odds of a `standard` competition (not in
 * SCRAPER_PRIORITY_COMPETITIONS) read 30 min / 2 h / 6 h instead of 10 min / 30 min / 2 h; with
 * SCRAPER_SKIP_REDUNDANT_SCORES=on a metered scores source that would be a third full-time
 * upstream is not read, and one that is needed as the second always is.
 */

const SECRET = 'SCRAPER_SECRET_THEODDSAPI';
const options = { random: () => 0 };
const actor = { system: 'test' };
const ODDS_CONFIG = {
  allowedHosts: ['api.the-odds-api.com'],
  secret: SECRET,
  sport: 'football',
  sportKey: 'soccer_epl',
  competition: 'Premier League',
  bookmakers: ['pinnacle', 'williamhill'],
};
const ODDS_URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(ODDS_CONFIG));
const SCORES_CONFIG = {
  allowedHosts: ['api.the-odds-api.com'],
  secret: SECRET,
  sport: 'football',
  sportKey: 'soccer_epl',
  competition: 'Premier League',
  mode: 'scores',
  scoreBasis: 'regular_time',
};
const SCORES_URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(SCORES_CONFIG));
/** A football-data.org source for the Premier League: full time and half time. */
const FOOTBALL_DATA_CONFIG = {
  allowedHosts: ['api.football-data.org'],
  requests: [{ url: 'https://api.football-data.org/v4/competitions/PL/matches', purpose: 'both' }],
  sport: 'football',
  recordsPath: 'matches',
  fields: {
    home: 'homeTeam.name',
    away: 'awayTeam.name',
    competition: { fixed: 'Premier League' },
    kickoff: { path: 'utcDate', format: 'iso' },
    externalRef: 'id',
    status: { path: 'status', map: { FINISHED: 'finished', TIMED: 'scheduled' } },
    score: {
      homePath: 'score.fullTime.home',
      awayPath: 'score.fullTime.away',
      htHomePath: 'score.halfTime.home',
      htAwayPath: 'score.halfTime.away',
    },
  },
  scoreBasis: 'regular_time',
};

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const runsOf = (sourceId: string) =>
  h.count(`SELECT count(*) AS n FROM scrape_runs WHERE source_id = '${sourceId}'`);

/** The database stamps updated_at with the real clock; the harness runs on its own. */
const backdate = (sourceId: string) =>
  h.pool.query(`UPDATE scrape_sources SET updated_at = $1 WHERE id = $2`, [
    new Date(h.now().getTime() - 24 * HOUR),
    sourceId,
  ]);

/** A finished run of `sourceId` a minute ago (ok, or failed). */
async function recordedRun(sourceId: string, ok: boolean): Promise<void> {
  const startedAt = new Date(h.now().getTime() - MINUTE);
  await h.ctx.db.transaction(async (tx) => {
    const run = await startRun(tx, { sourceId, startedAt });
    await finishRun(tx, run.id, {
      status: ok ? 'ok' : 'failed',
      finishedAt: new Date(startedAt.getTime() + 1000),
      issues: ok
        ? []
        : [{ severity: 'error', code: 'fetch_http_error', message: 'HTTP 500', context: {} }],
    });
  });
}

describe('odds tiers', () => {
  /** Only the odds source is enabled; one match 2 hours ahead, two books. */
  async function oddsHarness(over: HarnessOptions = {}): Promise<void> {
    h = await createHarness({ secrets: { [SECRET]: 'odds-test-key' }, ...over });
    await h.ctx.db.transaction(async (tx) => {
      await setSourceEnabled(tx, 'src-a', false, actor);
      await setSourceEnabled(tx, 'src-b', false, actor);
      await upsertSource(
        tx,
        {
          id: 'src-odds',
          name: 'odds',
          adapter: 'theoddsapi',
          upstream: 'TheOddsAPI',
          config: ODDS_CONFIG,
        },
        actor,
      );
      await setSourceEnabled(tx, 'src-odds', true, actor);
    });
    await backdate('src-odds');
    const at = h.now().toISOString();
    const book = (key: string) => ({
      key,
      last_update: at,
      markets: [
        {
          key: 'h2h',
          last_update: at,
          outcomes: [
            { name: 'Arsenal', price: 2.1 },
            { name: 'Draw', price: 3.4 },
            { name: 'Chelsea', price: 3.5 },
          ],
        },
      ],
    });
    h.serve(ODDS_URL, {
      status: 200,
      body: JSON.stringify([
        {
          id: 'ars-che',
          sport_key: 'soccer_epl',
          commence_time: new Date(h.now().getTime() + 2 * HOUR).toISOString(),
          home_team: 'Arsenal',
          away_team: 'Chelsea',
          bookmakers: [book('pinnacle'), book('williamhill')],
        },
      ]),
      headers: { 'x-requests-last': '2', 'x-requests-used': '17', 'x-requests-remaining': '483' },
    });
  }

  /** Runs once, then reports whether it is due again `afterMinutes` later. */
  async function dueAfter(afterMinutes: number): Promise<boolean> {
    h.advance(afterMinutes * MINUTE);
    return (await runDueSources(h.ctx, options)).due === 1;
  }

  it(
    'default config: every competition is priority, read every 10 minutes within 3 hours (as before)',
    async () => {
      await oddsHarness();
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      expect(await dueAfter(9)).toBe(false);
      expect(await dueAfter(1)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'a listed (priority) competition keeps the 10-minute schedule',
    async () => {
      await oddsHarness({ priorityCompetitions: 'la-liga,premier-league' });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      expect(await dueAfter(10)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'a standard competition (not listed) is read every 30 minutes within 3 hours',
    async () => {
      await oddsHarness({ priorityCompetitions: 'la-liga' });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      expect(await dueAfter(10)).toBe(false);
      expect(await dueAfter(19)).toBe(false);
      expect(await dueAfter(1)).toBe(true);
      expect(await runsOf('src-odds')).toBe(2);
    },
    TEST_TIMEOUT,
  );
});

describe('redundant scores sources', () => {
  /**
   * The scores source, an unresulted Premier League match that kicked off 2 hours ago, and
   * openfootball (src-a: full time and half time) enabled and healthy. `footballData` adds a
   * healthy football-data.org source: the scores source is then a third full-time upstream.
   */
  async function scoresHarness(over: HarnessOptions, footballData: boolean): Promise<void> {
    h = await createHarness({ secrets: { [SECRET]: 'odds-test-key' }, ...over });
    await h.ctx.db.transaction(async (tx) => {
      await setSourceEnabled(tx, 'src-b', false, actor);
      await upsertSource(
        tx,
        {
          id: 'src-scores',
          name: 'scores',
          adapter: 'theoddsapi',
          upstream: 'TheOddsAPI',
          config: SCORES_CONFIG,
        },
        actor,
      );
      await setSourceEnabled(tx, 'src-scores', true, actor);
      if (footballData) {
        await upsertSource(
          tx,
          {
            id: 'src-fd',
            name: 'football-data.org',
            adapter: 'generic-json',
            upstream: 'football-data.org',
            config: FOOTBALL_DATA_CONFIG,
          },
          actor,
        );
        await setSourceEnabled(tx, 'src-fd', true, actor);
      }
    });
    await backdate('src-scores');
    h.serve(SCORES_URL, { status: 200, body: '[]' });
    await h.pool.query(
      `INSERT INTO events (game_id, sport_id, competition_id, home_team_id, away_team_id, start_time,
                           status, feed_provider, feed_ref)
       VALUES (810001, 'football', $1, $2, $3, $4, 'live', 'scraped', 'tiers-test-1')`,
      [h.premier, h.team('Arsenal'), h.team('Chelsea'), new Date(h.now().getTime() - 2 * HOUR)],
    );
    // The other upstreams ran a minute ago, so they are healthy and not due in this pass.
    await recordedRun('src-a', true);
    if (footballData) await recordedRun('src-fd', true);
  }

  it(
    'default (off): a scores source is read even where it is a third upstream (as before)',
    async () => {
      await scoresHarness({}, true);
      await runDueSources(h.ctx, options);
      expect(await runsOf('src-scores')).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'on: a redundant scores source is not read, logged once; it is read again once an upstream fails',
    async () => {
      await scoresHarness({ skipRedundantScores: true }, true);
      const lines: Array<Record<string, unknown>> = [];
      h.ctx.logger = pino(
        { level: 'info' },
        { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      );
      const skipLogs = () => lines.filter((l) => l.reason === 'redundant_scores_upstream');
      await runDueSources(h.ctx, options);
      expect(await runsOf('src-scores')).toBe(0);
      h.advance(MINUTE);
      await runDueSources(h.ctx, options);
      expect(await runsOf('src-scores')).toBe(0);
      expect(skipLogs()).toHaveLength(1);
      expect(skipLogs()[0]).toMatchObject({
        sourceId: 'src-scores',
        competition: 'premier-league',
      });

      // football-data.org fails: the scores source is needed as the second upstream again.
      await recordedRun('src-fd', false);
      await runDueSources(h.ctx, options);
      expect(await runsOf('src-scores')).toBe(1);
      expect(
        lines.some(
          (l) => l.msg === 'scores source read again: it is needed as a full-time upstream',
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'on: a scores source needed as the second full-time upstream is read',
    async () => {
      await scoresHarness({ skipRedundantScores: true }, false);
      await runDueSources(h.ctx, options);
      expect(await runsOf('src-scores')).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

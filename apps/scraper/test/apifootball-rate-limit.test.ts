import { setSourceEnabled, upsertSource } from '@vamos/db';
import { apiFootballUrl } from '@vamos/scraper';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { creditAlarmSubject } from '../src/pipeline/credit-alarms';
import { cliHarness } from './cli-helpers';
import { createHarness, HOUR, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/**
 * API-Football in shadow (task A3): the by-date source runs with every competition policy off,
 * its daily request limit is read from each answer and stored with the run under its own key
 * (never under the credit guard of The Odds API), an alarm opens near the limit and closes once a
 * reading is above it, and `sources budget` lists today's reading.
 */

const SECRET = 'SCRAPER_SECRET_API_FOOTBALL';
const KEY = 'apifootball-key-for-tests-only';
const actor = { system: 'test' };
const CONFIG = {
  allowedHosts: ['v3.football.api-sports.io'],
  secret: SECRET,
  sport: 'football',
  daysBack: 1,
  daysAhead: 1,
};

let h: Harness;

const EMPTY_DAY = (day: string) =>
  JSON.stringify({
    get: 'fixtures',
    parameters: { date: day, timezone: 'UTC' },
    errors: [],
    results: 0,
    paging: { current: 1, total: 1 },
    response: [],
  });

/** Serves the three days of the plan, each answer reporting `remaining` of a 7,500 limit. */
function serveDays(remaining: number[]): void {
  const today = Math.floor(h.now().getTime() / (24 * HOUR)) * 24 * HOUR;
  [-1, 0, 1].forEach((offset, i) => {
    const day = new Date(today + offset * 24 * HOUR).toISOString().slice(0, 10);
    h.serve(apiFootballUrl(day), {
      status: 200,
      body: EMPTY_DAY(day),
      headers: {
        'x-ratelimit-requests-limit': '7500',
        'x-ratelimit-requests-remaining': String(remaining[i]),
        'x-ratelimit-limit': '300',
        'x-ratelimit-remaining': '299',
      },
    });
  });
}

async function openAlarms(): Promise<Array<{ status: string; payload: Record<string, unknown> }>> {
  const { rows } = await h.pool.query<{ status: string; payload: Record<string, unknown> }>(
    `SELECT status, payload FROM scrape_review_items WHERE subject_key = $1 ORDER BY created_at`,
    [creditAlarmSubject(SECRET, 'rate_limit')],
  );
  return rows;
}

beforeAll(async () => {
  h = await createHarness({ secrets: { [SECRET]: KEY } });
  await h.ctx.db.transaction(async (tx) => {
    await setSourceEnabled(tx, 'src-a', false, actor);
    await setSourceEnabled(tx, 'src-b', false, actor);
    await upsertSource(
      tx,
      {
        id: 'apifootball-bydate',
        name: 'API-Football by date (shadow)',
        adapter: 'apifootball',
        upstream: 'api-sports',
        config: CONFIG,
      },
      actor,
    );
    await setSourceEnabled(tx, 'apifootball-bydate', true, actor);
  });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

describe('API-Football in shadow (task A3)', () => {
  it(
    'sends the key only in its header and stores the day’s reading with the run',
    async () => {
      serveDays([7420, 7419, 7418]);
      const run = await h.run('apifootball-bydate');
      expect(run.status).toBe('ok');
      expect(run.requests).toBe(3);

      const sent = h.requests.filter((r) => r.url.startsWith('https://v3.football.api-sports.io/'));
      expect(sent).toHaveLength(3);
      for (const r of sent) {
        expect(r.url).not.toContain(KEY);
        expect(Object.entries(r.headers).filter(([, v]) => v === KEY)).toEqual([
          ['x-apisports-key', KEY],
        ]);
      }
      const { rows } = await h.pool.query<{
        api_credits_spent: number;
        api_credits_used: number;
        api_credits_remaining: number;
      }>(
        `SELECT api_credits_spent, api_credits_used, api_credits_remaining FROM scrape_runs WHERE id = $1`,
        [run.runId],
      );
      // Three answers counted; the last answer's reading kept.
      expect(rows[0]).toEqual({
        api_credits_spent: 3,
        api_credits_used: 82,
        api_credits_remaining: 7418,
      });
      expect(await openAlarms()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'opens a rate_limit_low alarm under 10% left, once, and closes it on a reading above',
    async () => {
      h.advance(HOUR);
      serveDays([800, 760, 700]);
      expect((await h.run('apifootball-bydate')).status).toBe('ok');
      let alarms = await openAlarms();
      expect(alarms).toHaveLength(1);
      expect(alarms[0]!.status).toBe('open');
      expect(alarms[0]!.payload).toMatchObject({
        reason: 'rate_limit_low',
        limit: 7500,
        remaining: 700,
        sourceId: 'apifootball-bydate',
      });

      // Still low: the same item is refreshed, not a second one.
      h.advance(HOUR);
      serveDays([650, 640, 630]);
      await h.run('apifootball-bydate');
      alarms = await openAlarms();
      expect(alarms).toHaveLength(1);
      expect(alarms[0]!.payload).toMatchObject({ remaining: 630 });

      // After midnight the limit is back.
      h.advance(24 * HOUR);
      serveDays([7499, 7498, 7497]);
      await h.run('apifootball-bydate');
      alarms = await openAlarms();
      expect(alarms).toHaveLength(1);
      expect(alarms[0]!.status).not.toBe('open');
    },
    TEST_TIMEOUT,
  );

  it(
    'shows today’s reading in sources budget, apart from the credit keys',
    async () => {
      const cli = cliHarness({ db: h.ctx.db });
      // The CLI's clock is the harness's T0; the runs above are later, so read them as of now.
      const run = await cli.run('sources', 'budget', '--json');
      expect(run.code).toBe(0);
      const json = JSON.parse(run.stdout) as {
        keys: Array<{ creditKey: string }>;
        dailyLimits: Array<Record<string, unknown>>;
      };
      expect(json.keys.map((k) => k.creditKey)).not.toContain(SECRET);
      expect(json.dailyLimits).toHaveLength(1);
      expect(json.dailyLimits[0]).toMatchObject({
        creditKey: SECRET,
        sources: ['apifootball-bydate'],
      });
      const text = await cli.run('sources', 'budget');
      expect(text.stdout).toContain('daily request limits');
      expect(text.stdout).toContain(SECRET);
    },
    TEST_TIMEOUT,
  );
});

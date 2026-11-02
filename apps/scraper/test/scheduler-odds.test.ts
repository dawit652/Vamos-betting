import { finishRun, setSourceEnabled, startRun, upsertSource } from '@vamos/db';
import { theOddsApiUrl, TheOddsApiConfigSchema } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { runDueSources } from '../src/tasks/scheduler';
import { creditAlarmSubject } from '../src/pipeline/credit-alarms';
import { createHarness, HOUR, MINUTE, SETUP_TIMEOUT, TEST_TIMEOUT, type Harness } from './helpers';

/**
 * The reading schedule of a bookmaker-odds source and its credit guard (docs/theoddsapi-plan
 * README.md, 4.5 and 4.7): read by the next kickoff in its own price rows, slowed or stopped by
 * the usage its runs recorded. No licence switch: the owner chose the paid plan as the licence.
 */

const SECRET = 'SCRAPER_SECRET_THEODDSAPI';
const CONFIG = {
  allowedHosts: ['api.the-odds-api.com'],
  secret: SECRET,
  sport: 'football',
  sportKey: 'soccer_epl',
  competition: 'Premier League',
  bookmakers: ['pinnacle', 'williamhill'],
};
const URL = theOddsApiUrl(TheOddsApiConfigSchema.parse(CONFIG));
const options = { random: () => 0 };
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const runs = () => h.count(`SELECT count(*) AS n FROM scrape_runs WHERE source_id = 'src-odds'`);

/** One match `kickoffIn` from now, two books; the response reports this usage. */
function serveOdds(kickoffIn: number, usage = { last: '2', used: '17', remaining: '483' }) {
  const at = h.now().toISOString();
  const kickoff = new Date(h.now().getTime() + kickoffIn).toISOString();
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
  h.serve(URL, {
    status: 200,
    body: JSON.stringify([
      {
        id: 'ars-che',
        sport_key: 'soccer_epl',
        commence_time: kickoff,
        home_team: 'Arsenal',
        away_team: 'Chelsea',
        bookmakers: [book('pinnacle'), book('williamhill')],
      },
    ]),
    headers: {
      'x-requests-last': usage.last,
      'x-requests-used': usage.used,
      'x-requests-remaining': usage.remaining,
    },
  });
}

/** Only the odds source is enabled; it was last changed a day before the harness clock. */
async function oddsHarness(): Promise<void> {
  h = await createHarness({ secrets: { [SECRET]: 'odds-test-key' } });
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
        config: CONFIG,
      },
      actor,
    );
    await setSourceEnabled(tx, 'src-odds', true, actor);
  });
  await setUpdatedAt(new Date(h.now().getTime() - 24 * HOUR));
}

/** The database stamps updated_at with the real clock; the harness runs on its own. */
const setUpdatedAt = (at: Date) =>
  h.pool.query(`UPDATE scrape_sources SET updated_at = $1 WHERE id = 'src-odds'`, [at]);

/** A finished run of the odds source at `startedAt`, as run-source records one. */
async function recordedRun(
  startedAt: Date,
  input: { credits?: { spent: number; used: number; remaining: number }; status401?: boolean },
) {
  await h.ctx.db.transaction(async (tx) => {
    const run = await startRun(tx, { sourceId: 'src-odds', startedAt });
    await finishRun(tx, run.id, {
      status: input.status401 ? 'failed' : 'ok',
      finishedAt: new Date(startedAt.getTime() + 1000),
      issues: input.status401
        ? [
            {
              severity: 'error',
              code: 'fetch_http_error',
              message: 'HTTP 401: login is never attempted',
              context: { url: URL, status: 401 },
            },
          ]
        : [],
      ...(input.credits === undefined ? {} : { apiCredits: input.credits }),
    });
  });
}

describe('odds reading schedule (4.5)', () => {
  it(
    'reads every 10 minutes with a kickoff within 3 hours, and records the credits',
    async () => {
      await oddsHarness();
      serveOdds(2 * HOUR);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      const { rows } = await h.pool.query<{
        api_credits_spent: number;
        api_credits_used: number;
        api_credits_remaining: number;
      }>(
        `SELECT api_credits_spent, api_credits_used, api_credits_remaining FROM scrape_runs WHERE source_id = 'src-odds'`,
      );
      expect(rows).toEqual([
        { api_credits_spent: 2, api_credits_used: 17, api_credits_remaining: 483 },
      ]);

      h.advance(9 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0 });
      h.advance(1 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      expect(await runs()).toBe(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'reads every 2 hours when the next kickoff is days away',
    async () => {
      await oddsHarness();
      serveOdds(3 * 24 * HOUR);
      await runDueSources(h.ctx, options);
      h.advance(HOUR + 59 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0 });
      h.advance(MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1 });
    },
    TEST_TIMEOUT,
  );

  it(
    'flags a request that costs more than the 2 credits expected (G3)',
    async () => {
      await oddsHarness();
      serveOdds(2 * HOUR, { last: '4', used: '21', remaining: '479' });
      await runDueSources(h.ctx, options);
      const { rows } = await h.pool.query<{ issues: Array<{ code: string }> }>(
        `SELECT issues FROM scrape_runs WHERE source_id = 'src-odds'`,
      );
      expect(rows[0]!.issues.map((i) => i.code)).toContain('unexpected_cost');
    },
    TEST_TIMEOUT,
  );
});

describe('credit guard (4.7)', () => {
  it(
    'stops under 1% of the quota, and reads again from the 1st of next month',
    async () => {
      await oddsHarness();
      serveOdds(2 * HOUR);
      await recordedRun(new Date(h.now().getTime() - 7 * HOUR), {
        credits: { spent: 2, used: 496, remaining: 4 },
      });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0 });
      // The quota resets on the 1st (UTC): last month's reading no longer counts.
      const now = h.now();
      h.at(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5)));
      serveOdds(2 * HOUR);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
    },
    TEST_TIMEOUT,
  );

  it(
    'in minimal mode reads only a league with a kickoff within 3 hours, every 30 minutes',
    async () => {
      await oddsHarness();
      // No stored prices yet: no kickoff known, so minimal does not read at all.
      await recordedRun(new Date(h.now().getTime() - 20 * MINUTE), {
        credits: { spent: 2, used: 460, remaining: 40 }, // 8% left
      });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0 });

      // A league with prices stored for a match in 2 hours (a run before the guard tightened).
      await h.pool.query(`DELETE FROM scrape_runs WHERE source_id = 'src-odds'`);
      serveOdds(2 * HOUR, { last: '2', used: '462', remaining: '38' });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      // Normal would read again after 10 minutes; minimal waits 30.
      h.advance(10 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0 });
      h.advance(20 * MINUTE);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1 });
    },
    TEST_TIMEOUT,
  );

  it(
    'stops after a refused key (401) until a person re-enables the source',
    async () => {
      await oddsHarness();
      serveOdds(2 * HOUR);
      const refusedAt = new Date(h.now().getTime() - 7 * HOUR);
      await recordedRun(refusedAt, { status401: true });
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0 });
      h.advance(6 * HOUR);
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 0 });
      // Re-enabled after the refusal.
      await setUpdatedAt(new Date(h.now().getTime() - MINUTE));
      expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
    },
    TEST_TIMEOUT,
  );
});

describe('licensed mode', () => {
  it(
    'runs in licensed mode with no extra switch (owner decision 2026-11-02: rule L3 removed)',
    async () => {
      await oddsHarness();
      serveOdds(2 * HOUR);
      const demo = h.ctx.config;
      const ctx = h.ctx as { config: typeof demo };
      ctx.config = { ...demo, mode: 'licensed' };
      try {
        expect(await runDueSources(h.ctx, options)).toMatchObject({ due: 1, ran: 1 });
      } finally {
        ctx.config = demo;
      }
    },
    TEST_TIMEOUT,
  );
});

/** The source_broken items of one alarm subject: [status, reason] each, oldest first. */
const alarms = async (subject: string) =>
  (
    await h.pool.query<{ status: string; reason: string }>(
      `SELECT status, payload->>'reason' AS reason FROM scrape_review_items
        WHERE kind = 'source_broken' AND subject_key = $1 ORDER BY created_at`,
      [subject],
    )
  ).rows.map((r) => [r.status, r.reason]);

describe('alarms (4.8)', () => {
  const budget = creditAlarmSubject(SECRET, 'budget');

  it(
    'budget_low while the guard is in minimal, once, resolved when normal; budget_exhausted at stop',
    async () => {
      await oddsHarness();
      serveOdds(2 * HOUR);
      const at = (minutes: number) => new Date(h.now().getTime() - minutes * MINUTE);
      await recordedRun(at(60), { credits: { spent: 2, used: 18_500, remaining: 1_500 } }); // 7.5%
      await runDueSources(h.ctx, options);
      await runDueSources(h.ctx, options);
      expect(await alarms(budget)).toEqual([['open', 'budget_low']]);

      await recordedRun(at(1), { credits: { spent: 2, used: 5_000, remaining: 15_000 } });
      await runDueSources(h.ctx, options);
      expect(await alarms(budget)).toEqual([['resolved', 'budget_low']]);

      h.advance(MINUTE);
      await recordedRun(h.now(), { credits: { spent: 2, used: 19_900, remaining: 100 } }); // 0.5%
      h.advance(MINUTE);
      await runDueSources(h.ctx, options);
      expect(await alarms(budget)).toEqual([
        ['resolved', 'budget_low'],
        ['open', 'budget_exhausted'],
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'unauthorized on a refused key, once however often, resolved by a successful read',
    async () => {
      await oddsHarness();
      const unauthorized = creditAlarmSubject(SECRET, 'unauthorized');
      h.serve(URL, {
        status: 401,
        body: '{"message":"API key is not valid","error_code":"INVALID_KEY"}',
      });
      await h.run('src-odds');
      await h.run('src-odds');
      expect(await alarms(unauthorized)).toEqual([['open', 'unauthorized']]);
      // The budget alarm is not raised for a refused key: that stop is this alarm's.
      await runDueSources(h.ctx, options);
      expect(await alarms(budget)).toEqual([]);

      serveOdds(2 * HOUR);
      expect((await h.run('src-odds')).status).toBe('ok');
      expect(await alarms(unauthorized)).toEqual([['resolved', 'unauthorized']]);
    },
    TEST_TIMEOUT,
  );

  it(
    'unexpected_cost when a request costs more than expected, open until a person dismisses it',
    async () => {
      await oddsHarness();
      const subject = creditAlarmSubject(SECRET, 'unexpected_cost');
      serveOdds(2 * HOUR, { last: '4', used: '21', remaining: '479' });
      await h.run('src-odds');
      await h.run('src-odds');
      expect(await alarms(subject)).toEqual([['open', 'unexpected_cost']]);
      serveOdds(2 * HOUR); // back to 2 credits: still open, a person decides
      await h.run('src-odds');
      expect(await alarms(subject)).toEqual([['open', 'unexpected_cost']]);
    },
    TEST_TIMEOUT,
  );
});

import { addTeamAlias, setSourceEnabled } from '@vamos/db';
import { normalizeName } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { promoteResults } from '../src/pipeline/promote-results';
import { reresolveUnresolved } from '../src/pipeline/run-source';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  FAR_JSON,
  FAR_OF,
  finishedJson,
  finishedOf,
  HOUR,
  jsonDoc,
  KICKOFF,
  MINUTE,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
  type HarnessOptions,
} from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

async function start(options?: HarnessOptions): Promise<void> {
  h = await createHarness(options);
}

/** Both sources list the sample fixture and the event is created. */
async function withEvent(options?: HarnessOptions): Promise<void> {
  await start(options);
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

/** Both sources show a final score `ft`, two hours after kickoff. */
async function finalScores(a: [number, number], b: [number, number]): Promise<void> {
  h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
  h.serve(URL_A, ofDoc([finishedOf(a)]));
  h.serve(URL_B, jsonDoc([finishedJson(b)]));
  await h.run('src-a');
  await h.run('src-b');
}

const eventState = async () =>
  (
    await h.pool.query<{ status: string; betting_open: boolean; resulted_at: Date | null }>(
      `SELECT status, betting_open, resulted_at FROM events WHERE feed_provider = 'scraped'`,
    )
  ).rows;
const resultedOutbox = () =>
  h.count(
    `SELECT count(*) AS n FROM outbox_events WHERE type IN ('event.resulted', 'event.result_corrected')`,
  );
const openItems = (kind: string) =>
  h.count(`SELECT count(*) AS n FROM scrape_review_items WHERE kind = $1 AND status = 'open'`, [
    kind,
  ]);
const observations = () => h.count(`SELECT count(*) AS n FROM scrape_observations`);

async function expectUntouched(): Promise<void> {
  const rows = await eventState();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'scheduled', betting_open: false, resulted_at: null });
  expect(await resultedOutbox()).toBe(0);
}

describe('S1: a page whose shape collapses', () => {
  it(
    'is a broken run: nothing is stored, source_broken opens, the event is untouched',
    async () => {
      await withEvent();
      for (let i = 0; i < 3; i += 1) {
        h.advance(20 * MINUTE);
        expect((await h.run('src-a')).status).toBe('ok');
      }
      const before = await observations();

      h.advance(20 * MINUTE);
      h.serve(URL_A, ofDoc([]));
      const empty = await h.run('src-a');
      expect(empty.status).toBe('broken');

      h.advance(20 * MINUTE);
      h.serve(URL_A, 'this is not json at all');
      expect((await h.run('src-a')).status).toBe('broken');

      expect(await observations()).toBe(before);
      expect(await openItems('source_broken')).toBe(1);
      await promoteFixtures(h.ctx);
      await promoteResults(h.ctx);
      await expectUntouched();

      // A healthy page closes the item again.
      h.advance(20 * MINUTE);
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      expect((await h.run('src-a')).status).toBe('ok');
      expect(await openItems('source_broken')).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'an invalid configuration is a failed run and a source_broken item; the source stays enabled',
    async () => {
      await start();
      await h.pool.query(
        `UPDATE scrape_sources SET config = '{"nonsense": true}' WHERE id = 'src-a'`,
      );
      const result = await h.run('src-a');
      expect(result.status).toBe('failed');
      expect(await openItems('source_broken')).toBe(1);
      const { rows } = await h.pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM scrape_sources WHERE id = 'src-a'`,
      );
      expect(rows[0]?.enabled).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

describe('F5: absence never cancels', () => {
  it(
    'a partial listing changes nothing; fixture_missing opens only after 48 hours',
    async () => {
      await withEvent();
      // From now on both sources list only some other (far away) fixture.
      h.serve(URL_A, ofDoc([FAR_OF]));
      h.serve(URL_B, jsonDoc([FAR_JSON]));

      h.advance(47 * HOUR);
      expect((await h.run('src-a')).status).toBe('ok');
      expect((await h.run('src-b')).status).toBe('ok');
      await promoteFixtures(h.ctx);
      expect(await openItems('fixture_missing')).toBe(0);
      await expectUntouched();

      h.advance(2 * HOUR);
      await h.run('src-a');
      await h.run('src-b');
      await promoteFixtures(h.ctx);
      await promoteResults(h.ctx);
      expect(await openItems('fixture_missing')).toBe(1);
      await expectUntouched();
      expect(await h.count(`SELECT count(*) AS n FROM events`)).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('S2: a blocked source', () => {
  it(
    'is a blocked run that stores nothing',
    async () => {
      await withEvent();
      const before = await observations();
      h.advance(20 * MINUTE);
      h.serve(URL_A, { status: 403, body: 'Access denied' });
      const result = await h.run('src-a');
      expect(result.status).toBe('blocked');
      expect(await observations()).toBe(before);
      const { rows } = await h.pool.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM scrape_runs WHERE id = $1`,
        [result.runId],
      );
      expect(rows[0]?.status).toBe('blocked');
      await promoteFixtures(h.ctx);
      await expectUntouched();
    },
    TEST_TIMEOUT,
  );

  it(
    'S3: a redirect to a host the adapter does not allow is refused: a failed run, nothing stored',
    async () => {
      await start();
      h.serve(URL_A, {
        status: 302,
        body: '',
        headers: { location: 'https://evil.example.net/en1.json' },
      });
      h.serve('https://evil.example.net/en1.json', ofDoc([ARSENAL_CHELSEA_OF]));
      expect((await h.run('src-a')).status).toBe('failed');
      expect(await observations()).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe('R3: dissent blocks', () => {
  it(
    'sources disagreeing on the score: result_conflict, nothing applied',
    async () => {
      await withEvent();
      await finalScores([2, 1], [1, 1]);
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteResults(h.ctx);
      expect(summary.applied).toBe(0);
      expect(await openItems('result_conflict')).toBe(1);
      await expectUntouched();
      // Still nothing when it is run again.
      await promoteResults(h.ctx);
      expect(await openItems('result_conflict')).toBe(1);
      await expectUntouched();
    },
    TEST_TIMEOUT,
  );

  it(
    'a source reporting the match postponed blocks the result and proposes a cancellation',
    async () => {
      await withEvent();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1])]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, st: 'PST' }]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      await promoteResults(h.ctx);
      expect(await openItems('cancellation_proposed')).toBe(1);
      await expectUntouched();
    },
    TEST_TIMEOUT,
  );
});

describe('R2/R6: independent upstreams', () => {
  it(
    'two sources with the same upstream never apply; a person is asked after the wait',
    async () => {
      await withEvent({ upstreamB: 'openfootball' });
      await finalScores([2, 1], [2, 1]);
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      expect(await openItems('result_unverified')).toBe(0);
      await expectUntouched();

      h.at(new Date(KICKOFF.getTime() + 8 * HOUR));
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      expect(await openItems('result_unverified')).toBe(1);
      await expectUntouched();
    },
    TEST_TIMEOUT,
  );

  it(
    'S4: a disabled source votes no more; the lone source is only ever unverified',
    async () => {
      await withEvent();
      await finalScores([2, 1], [2, 1]);
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', false, { system: 'test' }));
      h.advance(16 * MINUTE);
      await h.run('src-a');
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      await expectUntouched();

      h.at(new Date(KICKOFF.getTime() + 8 * HOUR));
      await h.run('src-a');
      await promoteResults(h.ctx);
      expect(await openItems('result_unverified')).toBe(1);
      await expectUntouched();

      // Enabled again, the second upstream completes the vote (and was stable long ago).
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', true, { system: 'test' }));
      expect((await promoteResults(h.ctx)).applied).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('N2: names', () => {
  it(
    'an unknown team opens unknown_team and creates nothing; an alias resolves it later',
    async () => {
      await start();
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, team2: 'Totally Unknown Town' }]));
      expect((await h.run('src-a')).status).toBe('ok');
      expect((await promoteFixtures(h.ctx)).created).toBe(0);
      expect(await h.count(`SELECT count(*) AS n FROM events`)).toBe(0);
      const { rows } = await h.pool.query<{ subject_key: string; payload: { raw: string } }>(
        `SELECT subject_key, payload FROM scrape_review_items WHERE kind = 'unknown_team' AND status = 'open'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.raw).toBe('Totally Unknown Town');
      expect(await observations()).toBe(1);

      await h.ctx.db.transaction((tx) =>
        addTeamAlias(
          tx,
          {
            sportId: 'football',
            aliasNorm: normalizeName('Totally Unknown Town'),
            sourceId: null,
            teamId: h.team('Chelsea'),
          },
          { system: 'test' },
        ),
      );
      expect(await reresolveUnresolved(h.ctx)).toBe(1);
      expect(await openItems('unknown_team')).toBe(0);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_observations WHERE away_team_id IS NOT NULL`,
        ),
      ).toBe(1);
      expect((await promoteFixtures(h.ctx)).created).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

describe('F4: kickoff change', () => {
  it(
    'two upstreams agreeing on a later time move the event without repricing it',
    async () => {
      await withEvent();
      const odds = () =>
        h.pool.query<{ id: string; odds_milli: number }>(
          `SELECT id, odds_milli FROM selections ORDER BY id`,
        );
      const before = (await odds()).rows;
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, time: '16:00' }]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T16:00:00Z' }]));
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteFixtures(h.ctx);
      expect(summary.kickoffMoved).toBe(1);
      const { rows } = await h.pool.query<{ start_time: Date }>(
        `SELECT start_time FROM events WHERE feed_provider = 'scraped'`,
      );
      expect(new Date(rows[0]!.start_time)).toEqual(new Date('2026-11-02T16:00:00Z'));
      expect((await odds()).rows).toEqual(before);
      expect(await h.count(`SELECT count(*) AS n FROM events`)).toBe(1);
      await expectUntouched();
      expect((await promoteFixtures(h.ctx)).kickoffMoved).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

describe('idempotence', () => {
  it(
    'running a source and the promotion repeatedly changes nothing after the first time',
    async () => {
      await withEvent();
      const history = () => h.count(`SELECT count(*) AS n FROM scrape_observation_history`);
      const items = () => h.count(`SELECT count(*) AS n FROM scrape_review_items`);
      const before = [await history(), await observations(), await items()];
      for (let i = 0; i < 3; i += 1) {
        h.advance(20 * MINUTE);
        await h.run('src-a');
        await h.run('src-b');
        await promoteFixtures(h.ctx);
        await promoteResults(h.ctx);
      }
      expect([await history(), await observations(), await items()]).toEqual(before);
      expect(await h.count(`SELECT count(*) AS n FROM events`)).toBe(1);
      await expectUntouched();
    },
    TEST_TIMEOUT,
  );
});

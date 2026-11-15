import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { promoteResults } from '../src/pipeline/promote-results';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  finishedJson,
  finishedOf,
  HOUR,
  KICKOFF,
  MINUTE,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  jsonDoc,
  ofDoc,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const OUTBOX_RESULTED = `SELECT count(*) AS n FROM outbox_events WHERE type = 'event.resulted'`;

describe('two independent sources, fixture to settlement', () => {
  it(
    'F2/F7: the fixture creates one event with betting closed and an odds_approval item',
    async () => {
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      expect((await h.run('src-a')).status).toBe('ok');
      expect((await h.run('src-b')).status).toBe('ok');

      const first = await promoteFixtures(h.ctx);
      expect(first.created).toBe(1);
      const { rows } = await h.pool.query<{
        feed_ref: string;
        betting_open: boolean;
        status: string;
        start_time: Date;
      }>(
        `SELECT feed_ref, betting_open, status, start_time FROM events WHERE feed_provider = 'scraped'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        feed_ref: `fx|${h.premier}|${h.team('Arsenal')}|${h.team('Chelsea')}|2026-11-02`,
        betting_open: false,
        status: 'scheduled',
      });
      expect(new Date(rows[0]!.start_time)).toEqual(KICKOFF);
      expect(await h.count(`SELECT count(*) AS n FROM markets`)).toBeGreaterThan(0);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM scrape_review_items WHERE kind = 'odds_approval' AND status = 'open'`,
        ),
      ).toBe(1);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.fixture.created' AND actor_id = 'system:scraper'`,
        ),
      ).toBe(1);

      // Idempotent: nothing more happens.
      const second = await promoteFixtures(h.ctx);
      expect(second.created).toBe(0);
      expect(
        await h.count(`SELECT count(*) AS n FROM events WHERE feed_provider = 'scraped'`),
      ).toBe(1);
      expect(await h.count(`SELECT count(*) AS n FROM scrape_review_items`)).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'R2/R4/R5: two upstreams agree, the score is applied once after the confirmation time',
    async () => {
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([2, 1], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');

      // Too early (R4): the observations are new.
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      expect(await h.count(OUTBOX_RESULTED)).toBe(0);

      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      const done = await promoteResults(h.ctx);
      expect(done.applied).toBe(1);

      const { rows } = await h.pool.query<{
        status: string;
        score_home: number;
        score_away: number;
      }>(`SELECT status, score_home, score_away FROM events WHERE feed_provider = 'scraped'`);
      expect(rows[0]).toMatchObject({ status: 'finished', score_home: 2, score_away: 1 });
      expect(
        await h.count(`SELECT count(*) AS n FROM markets WHERE status NOT IN ('settled', 'void')`),
      ).toBe(0);
      expect(await h.count(OUTBOX_RESULTED)).toBe(1);
      expect(await h.count(`SELECT count(*) AS n FROM scrape_rating_applied`)).toBe(1);
      for (const name of ['Arsenal', 'Chelsea']) {
        const { rows: r } = await h.pool.query<{ matches: string }>(
          `SELECT ratings->>'matches' AS matches FROM teams WHERE id = $1`,
          [h.team(name)],
        );
        expect(Number(r[0]?.matches)).toBe(11);
      }
      expect(
        await h.count(`SELECT count(*) AS n FROM scrape_raw WHERE keep`),
      ).toBeGreaterThanOrEqual(2);
      const { rows: audit } = await h.pool.query<{
        metadata: { sources: string[]; upstreams: string[]; evidenceHashes: string[] };
      }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.result.applied' AND actor_id = 'system:scraper'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata.sources).toEqual(['src-a', 'src-b']);
      expect(audit[0]!.metadata.upstreams).toEqual(['example-api', 'openfootball']);
      expect(audit[0]!.metadata.evidenceHashes.length).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT,
  );

  it(
    'R11: a second promotion changes nothing',
    async () => {
      h.advance(5 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      await promoteFixtures(h.ctx);
      expect(await h.count(OUTBOX_RESULTED)).toBe(1);
      expect(await h.count(`SELECT count(*) AS n FROM scrape_rating_applied`)).toBe(1);
      expect(
        await h.count(`SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.result.applied'`),
      ).toBe(1);
      const { rows } = await h.pool.query<{ matches: string }>(
        `SELECT ratings->>'matches' AS matches FROM teams WHERE id = $1`,
        [h.team('Arsenal')],
      );
      expect(Number(rows[0]?.matches)).toBe(11);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM events WHERE status <> 'finished' AND feed_provider = 'scraped'`,
        ),
      ).toBe(0);
    },
    TEST_TIMEOUT,
  );
});

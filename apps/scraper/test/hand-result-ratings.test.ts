import { staffResultEvent } from '@vamos/db';
import type { ResolutionInput } from '@vamos/core';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { HAND_RESULT_RATING_WINDOW_MS, rateHandResults } from '../src/pipeline/result-ratings';
import { runPromotion } from '../src/tasks/promote';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  HOUR,
  jsonDoc,
  KICKOFF,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/**
 * S-5, rule O4 for a result a person entered: a scraped match a trader resulted by hand in Trading
 * moves its teams' ratings once, like a result of the scraper's own gate. Real Postgres and Redis.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' };
const NONE = { checked: 0, rated: 0, failed: 0 };

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await h.pool.query<T>(query, params)).rows;

/** Both sources list the sample fixture; the promotion creates the event. */
async function createdEvent(): Promise<string> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  return (await rows<{ id: string }>(`SELECT id FROM events WHERE feed_provider = 'scraped'`))[0]!
    .id;
}

const ratingsOf = async (name: string) =>
  (
    await rows<{ ratings: Record<string, number> }>(`SELECT ratings FROM teams WHERE id = $1`, [
      h.team(name),
    ])
  )[0]!.ratings;

/** What a trader does in Trading: results the match by hand (or corrects it, with a reason). */
async function resultByHand(eventId: string, result: ResolutionInput, reason?: string) {
  await h.ctx.db.transaction((tx) =>
    staffResultEvent(tx, {
      eventId,
      result,
      ...(reason === undefined ? {} : { reason }),
      actor: STAFF,
      now: h.now(),
    }),
  );
}
const finished = (home: number, away: number): ResolutionInput => ({
  status: 'finished',
  score: { home, away, htHome: 0, htAway: 0 },
});

describe('S-5: ratings learn from a result a person entered', () => {
  it(
    'a hand result moves both teams once, audited; a second pass and a correction move nothing',
    async () => {
      const eventId = await createdEvent();
      const before = { home: await ratingsOf('Arsenal'), away: await ratingsOf('Chelsea') };
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      await resultByHand(eventId, finished(3, 0));

      expect(await rateHandResults(h.ctx)).toEqual({ checked: 1, rated: 1, failed: 0 });
      const after = { home: await ratingsOf('Arsenal'), away: await ratingsOf('Chelsea') };
      expect(after.home.matches).toBe(before.home.matches! + 1);
      expect(after.away.matches).toBe(before.away.matches! + 1);
      expect(after.home).not.toEqual(before.home);
      const [audit] = await rows<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'scrape.result.rated'`,
      );
      expect(audit!.metadata).toMatchObject({
        via: 'hand',
        rule: 'O4',
        score: { home: 3, away: 0 },
      });

      expect(await rateHandResults(h.ctx)).toEqual(NONE);
      await resultByHand(eventId, finished(2, 2), 'the score was entered wrong');
      expect(await rateHandResults(h.ctx)).toEqual(NONE);
      expect(await ratingsOf('Arsenal')).toEqual(after.home);
      expect(await ratingsOf('Chelsea')).toEqual(after.away);
    },
    TEST_TIMEOUT,
  );

  it(
    'a match whose ratings already moved (the gate, scrape_rating_applied) is not looked at',
    async () => {
      const eventId = await createdEvent();
      await h.pool.query(
        `INSERT INTO scrape_rating_applied (fixture_key) SELECT feed_ref FROM events WHERE id = $1`,
        [eventId],
      );
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      await resultByHand(eventId, finished(1, 0));
      const before = await ratingsOf('Arsenal');
      expect(await rateHandResults(h.ctx)).toEqual(NONE);
      expect(await ratingsOf('Arsenal')).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'a hand result for a match that kicked off before the window, and a cancelled match, are left alone',
    async () => {
      const eventId = await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      await resultByHand(eventId, { status: 'cancelled' });
      expect(await rateHandResults(h.ctx)).toEqual(NONE);

      await resultByHand(eventId, finished(1, 1), 'it was played after all');
      h.advance(HAND_RESULT_RATING_WINDOW_MS + HOUR);
      const before = await ratingsOf('Arsenal');
      expect(await rateHandResults(h.ctx)).toEqual(NONE);
      expect(await ratingsOf('Arsenal')).toEqual(before);
    },
    TEST_TIMEOUT,
  );

  it(
    'the promotion pass runs the step',
    async () => {
      const eventId = await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      await resultByHand(eventId, finished(0, 2));
      await runPromotion(h.ctx);
      expect(
        await rows(
          `SELECT 1 FROM scrape_rating_applied f JOIN events e ON e.feed_ref = f.fixture_key
          WHERE e.id = $1`,
          [eventId],
        ),
      ).toHaveLength(1);
      expect(
        await rows(`SELECT 1 FROM audit_log WHERE action = 'scrape.result.rated'`),
      ).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});

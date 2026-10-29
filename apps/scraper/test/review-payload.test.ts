import { parseReviewPayload } from '@vamos/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  KICKOFF,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
  type HarnessOptions,
} from './helpers';

/** The items written when an event is created (rule F7) have the contract's odds payload. */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

async function promoteNewEvent(options: HarnessOptions) {
  h = await createHarness(options);
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const { rows: events } = await h.pool.query<{ id: string; game_id: string }>(
    `SELECT id, game_id::text AS game_id FROM events WHERE feed_provider = 'scraped'`,
  );
  const { rows: items } = await h.pool.query<{
    kind: 'odds_approval' | 'ratings_uncalibrated';
    payload: unknown;
  }>(`SELECT kind, payload FROM scrape_review_items WHERE status = 'open'`);
  return { event: events[0]!, items };
}

describe('F7 review payload', () => {
  it(
    'a calibrated new event opens an odds_approval item the contract parses',
    async () => {
      const { event, items } = await promoteNewEvent({ calibrated: true });
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.kind).toBe('odds_approval');
      const payload = parseReviewPayload('odds_approval', item.payload);
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({
        eventId: event.id,
        gameId: event.game_id,
        home: 'Arsenal',
        away: 'Chelsea',
        reason: 'auto_open_off',
      });
      expect(new Date(payload!.kickoff)).toEqual(KICKOFF);
      expect(payload!.markets.length).toBeGreaterThan(0);
      expect(payload!.proposal).toBeUndefined();
      // The scraper's own fields stay.
      expect(item.payload).toMatchObject({ rules: ['F7'], autoOpen: false, calibrated: true });
    },
    TEST_TIMEOUT,
  );

  it(
    'an uncalibrated new event opens a ratings_uncalibrated item the contract parses',
    async () => {
      const { event, items } = await promoteNewEvent({ calibrated: false });
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.kind).toBe('ratings_uncalibrated');
      const payload = parseReviewPayload('ratings_uncalibrated', item.payload);
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({ eventId: event.id, reason: 'ratings_uncalibrated' });
    },
    TEST_TIMEOUT,
  );
});

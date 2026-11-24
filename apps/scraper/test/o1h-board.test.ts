import { isBoardPricedKey } from '@vamos/core';
import { setHulusportPricing } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { backedByMarket } from '../src/pipeline/event-pricing';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import { readHulusportBoard } from '../src/tasks/hulusport';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  KICKOFF,
  MINUTE,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/**
 * Rule O1h (the owner's locked odds, 16-18 Nov 2026): a match of ours whose teams are not
 * calibrated waits for a person, because the model would price it from empty ratings. With a fresh
 * Hulusport board linked to it, the whole book is priced from the board's expected goals, the match
 * is handed over for opening like a strong market (O1m), and it is suspended (A2) once the board is
 * no longer fresh.
 */

const MRX = 'http://mrx.test:3100';
const actor = { system: 'test' };

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

const item = (name: string, specifier: Record<string, string>, odds: Array<[string, number]>) => ({
  bet_group: { name },
  specifier,
  odds: odds.map(([outcome, odd]) => ({ bet_type: { name: outcome }, odd, is_available: true })),
});

function board(pricesAt: Date) {
  return {
    generated_at: pricesAt.toISOString(),
    worker: { last_success_at: pricesAt.toISOString() },
    matches: [
      {
        id: 2281709,
        hom: 'Arsenal',
        awy: 'Chelsea',
        schedule: KICKOFF.toISOString(),
        odds_checked_at: pricesAt.toISOString(),
        expired: false,
        league: { id: 17, name: 'Premier League', sport_type: 79, group: 'England' },
        items: [
          item('3 Way', {}, [
            ['{$competitor1}', 2.05],
            ['draw', 3.4],
            ['{$competitor2}', 3.6],
          ]),
          item('Over/Under', { total: '2.5' }, [
            ['over {total}', 1.9],
            ['under {total}', 1.9],
          ]),
        ],
      },
    ],
  };
}

const serve = (doc: unknown) => async () =>
  new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } });

describe('rule O1h: uncalibrated matches priced from the Hulusport board', () => {
  it(
    'prices the whole match from the board, hands it over for opening, and suspends it when the board goes stale',
    async () => {
      h = await createHarness({ hulusportUrl: MRX, calibrated: false });
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteFixtures(h.ctx)).created).toBe(1);
      const [event] = await rows<{ id: string; feed_ref: string; betting_open: boolean }>(
        `SELECT id, feed_ref, betting_open FROM events WHERE feed_provider = 'scraped'`,
      );
      const eventId = event!.id;
      // Teams not calibrated: betting closed, waiting for a person.
      expect(event!.betting_open).toBe(false);
      const waiting = await rows<{ kind: string }>(
        `SELECT kind FROM scrape_review_items WHERE subject_key = $1 AND status = 'open'`,
        [event!.feed_ref],
      );
      expect(waiting.map((r) => r.kind)).toContain('ratings_uncalibrated');

      // The board links to the match; with the switch on the next re-price takes the board's goals.
      await h.ctx.db.transaction((tx) => setHulusportPricing(tx, true, actor));
      expect((await readHulusportBoard(h.ctx, serve(board(h.now())))).linked).toBe(1);
      const summary = await repriceScheduledEvents(h.ctx);
      expect(summary.failed).toBe(0);
      const [stamp] = await rows<{ ratings_key: string }>(
        `SELECT ratings_key FROM scrape_event_pricing WHERE event_id = $1`,
        [eventId],
      );
      expect(isBoardPricedKey(stamp!.ratings_key)).toBe(true);

      // Handed over: the uncalibrated request is closed and an opening request is open, as for a
      // strong market (a person, or F7b in a league with auto open, opens it); the same check a
      // person's "Open betting" and F7b make holds: board prices back opening.
      const after = await rows<{ kind: string }>(
        `SELECT kind FROM scrape_review_items WHERE subject_key = $1 AND status = 'open'`,
        [event!.feed_ref],
      );
      expect(after.map((r) => r.kind)).not.toContain('ratings_uncalibrated');
      expect(after.map((r) => r.kind)).toContain('odds_approval');
      const input = {
        competitionPricingSource: 'model' as const,
        eventId,
        homeRatings: null,
        awayRatings: null,
        minRatingMatches: h.ctx.config.scraper.minRatingMatches,
        now: h.now(),
      };
      expect(await backedByMarket(h.ctx.db, input)).toBe(true);

      // Stale board: the prices made from it stop (A2), and nothing backs opening any more.
      h.advance(31 * MINUTE);
      const later = await repriceScheduledEvents(h.ctx);
      expect(later.suspended).toBe(1);
      const statuses = await rows<{ status: string; suspended_by: string | null }>(
        `SELECT status, suspended_by FROM markets WHERE event_id = $1`,
        [eventId],
      );
      expect(statuses.every((m) => m.status === 'suspended' && m.suspended_by === 'feed')).toBe(
        true,
      );
      expect(await backedByMarket(h.ctx.db, { ...input, now: h.now() })).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

import { loadGameSettings, quoteSlip } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { repriceScheduledEvents } from '../src/pipeline/reprice';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  MINUTE,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

/**
 * Rule P7 (price expiry): with SCRAPER_PRICE_EXPIRY_MINUTES set, the markets of a scraped event
 * carry price_valid_until; a pass over unchanged inputs pushes it forward once less than half the
 * window is left; with no pass, the price expires and takes no bet.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;

async function createdEvent(priceExpiryMinutes?: number): Promise<string> {
  h = await createHarness(priceExpiryMinutes === undefined ? {} : { priceExpiryMinutes });
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const [event] = await rows<{ id: string }>(
    `SELECT id FROM events WHERE feed_provider = 'scraped'`,
  );
  return event!.id;
}

/** The distinct price_valid_until of the event's markets, as ISO strings (null for none). */
async function expiries(eventId: string): Promise<Array<string | null>> {
  const found = await rows<{ until: Date | null }>(
    `SELECT DISTINCT price_valid_until AS until FROM markets WHERE event_id = $1`,
    [eventId],
  );
  return found.map((r) => r.until?.toISOString() ?? null);
}

const at = (minutes: number) => new Date(h.now().getTime() + minutes * MINUTE).toISOString();

describe('P7: price expiry of scraped events', () => {
  it(
    'is off by default: created and re-priced markets keep price_valid_until NULL',
    async () => {
      const eventId = await createdEvent();
      expect(await expiries(eventId)).toEqual([null]);
      h.advance(20 * MINUTE);
      await repriceScheduledEvents(h.ctx);
      expect(await expiries(eventId)).toEqual([null]);
    },
    TEST_TIMEOUT,
  );

  it(
    'stamps a created event, refreshes only in the second half of the window',
    async () => {
      const eventId = await createdEvent(30);
      const created = at(30);
      expect(await expiries(eventId)).toEqual([created]);

      // More than half the window left: not rewritten.
      h.advance(5 * MINUTE);
      await repriceScheduledEvents(h.ctx);
      expect(await expiries(eventId)).toEqual([created]);

      // Less than half left: pushed to now + 30 minutes.
      h.advance(15 * MINUTE);
      await repriceScheduledEvents(h.ctx);
      expect(await expiries(eventId)).toEqual([at(30)]);
      expect(at(30)).not.toBe(created);
    },
    TEST_TIMEOUT,
  );

  it(
    'refuses the selections as suspended once the clock passes the expiry with no pass',
    async () => {
      const eventId = await createdEvent(30);
      // Betting is closed on a new event until a person (or auto-open) opens it.
      await h.pool.query(`UPDATE events SET betting_open = true WHERE id = $1`, [eventId]);
      const selections = await rows<{ id: string }>(
        `SELECT s.id FROM selections s JOIN markets m ON m.id = s.market_id
          WHERE m.event_id = $1 AND m.key = '1x2'`,
        [eventId],
      );
      const legs = selections.map((s) => ({ selectionId: s.id }));
      const settings = await loadGameSettings(h.ctx.db);
      const quote = (now: Date) => quoteSlip(h.ctx.db, { legs, stake: 1_000n, settings, now });

      const before = await quote(new Date(h.now().getTime() + 29 * MINUTE));
      expect(before.legs.map((l) => l.reason)).toEqual(legs.map(() => null));

      const after = await quote(new Date(h.now().getTime() + 30 * MINUTE));
      expect(after.legs.map((l) => [l.available, l.reason])).toEqual(
        legs.map(() => [false, 'suspended']),
      );
    },
    TEST_TIMEOUT,
  );
});

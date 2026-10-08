import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockFeedProvider, runFeedIngest } from '../src/tasks/feed-ingest';
import {
  createWorkerTestContext,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  type WorkerTestContext,
} from './helpers';

let t: WorkerTestContext;

beforeAll(async () => {
  t = await createWorkerTestContext();
}, SETUP_TIMEOUT);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT);

/** Tuesday 13 Oct 2026, 09:02 in Addis Ababa (CAF midweek fixtures that day). */
const NOW = new Date('2026-10-13T06:02:00Z');

/** Teams with two scheduled mock events starting at the same time. */
async function doubleBooked(): Promise<string[]> {
  const { rows } = await t.db.pool.query<{ team: string }>(
    `SELECT tm.short_name || ' @ ' || e.start_time::text AS team
       FROM events e JOIN teams tm ON tm.id IN (e.home_team_id, e.away_team_id)
      WHERE e.feed_provider = 'mock' AND e.status = 'scheduled'
      GROUP BY tm.short_name, e.start_time HAVING count(*) > 1`,
  );
  return rows.map((row) => row.team);
}

describe('feed ingest reconciliation', () => {
  it(
    'cancels scheduled fixtures the feed stopped offering after a catalogue edit (regression)',
    async () => {
      t.clock.set(NOW);
      const first = await runFeedIngest(t.ctx);
      expect(first.withdrawn).toBe(0);
      expect(await doubleBooked()).toEqual([]);

      // Back-office edits change which fixtures the feed generates.
      await t.db.pool.query(
        `UPDATE competitions SET featured = NOT featured WHERE slug = 'ethiopian-premier-league'`,
      );
      await t.db.pool.query(`UPDATE competitions SET featured = true WHERE slug = 'bundesliga'`);
      const from = t.received.length;
      const second = await runFeedIngest(t.ctx);
      expect(second.created).toBeGreaterThan(0);
      expect(second.withdrawn).toBeGreaterThan(0);
      expect(second.failed).toBe(0);

      // The board now matches the feed: no orphans, and nobody plays twice at once.
      const provider = await createMockFeedProvider(t.db.db);
      const offered = new Set(provider.fixtures(NOW, 72).map((fixture) => fixture.feedRef));
      const { rows: scheduled } = await t.db.pool.query<{ feed_ref: string }>(
        `SELECT feed_ref FROM events WHERE feed_provider = 'mock' AND status = 'scheduled'`,
      );
      expect(scheduled.filter((row) => !offered.has(row.feed_ref))).toEqual([]);
      expect(scheduled).toHaveLength(offered.size);
      expect(await doubleBooked()).toEqual([]);

      // Withdrawn events are cancelled with every market void and an outbox event each.
      const { rows: cancelled } = await t.db.pool.query<{ id: string }>(
        `SELECT id FROM events WHERE feed_provider = 'mock' AND status = 'cancelled'`,
      );
      expect(cancelled).toHaveLength(second.withdrawn);
      const ids = cancelled.map((row) => row.id);
      const { rows: markets } = await t.db.pool.query<{ status: string }>(
        'SELECT DISTINCT status FROM markets WHERE event_id = ANY($1::uuid[])',
        [ids],
      );
      expect(markets.map((row) => row.status)).toEqual(['void']);
      const { rows: outbox } = await t.db.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM outbox_events
          WHERE type = 'event.resulted' AND aggregate_id = ANY($1::text[])`,
        [ids],
      );
      expect(Number(outbox[0]?.n)).toBe(ids.length);
      await t.waitForMessages(
        (messages) =>
          messages.slice(from).filter((m) => m.type === 'match' && m.data.st === 'cancelled')
            .length === ids.length,
      );

      // Stable again: the next run neither creates nor withdraws anything.
      const third = await runFeedIngest(t.ctx);
      expect(third).toMatchObject({ created: 0, withdrawn: 0, failed: 0 });
    },
    TEST_TIMEOUT * 2,
  );

  it(
    'never withdraws live events or those whose start has passed',
    async () => {
      const { rows } = await t.db.pool.query<{ id: string }>(
        `SELECT id FROM events WHERE feed_provider = 'mock' AND status = 'scheduled'
          ORDER BY start_time LIMIT 2`,
      );
      const [live, started] = rows.map((row) => row.id);
      await t.db.pool.query(`UPDATE events SET status = 'live' WHERE id = $1`, [live]);
      await t.db.pool.query(`UPDATE events SET feed_ref = feed_ref || ':gone' WHERE id = ANY($1)`, [
        [live, started],
      ]);
      const { rows: starts } = await t.db.pool.query<{ start_time: Date }>(
        'SELECT start_time FROM events WHERE id = $1',
        [started],
      );
      // The clock moves past the second event's start: it is no longer in the window.
      t.clock.set(new Date(starts[0]!.start_time.getTime() + 1000));
      const run = await runFeedIngest(t.ctx);
      expect(run.failed).toBe(0);
      const { rows: after } = await t.db.pool.query<{ id: string; status: string }>(
        'SELECT id, status FROM events WHERE id = ANY($1)',
        [[live, started]],
      );
      expect(new Map(after.map((row) => [row.id, row.status]))).toEqual(
        new Map([
          [live, 'live'],
          [started, 'scheduled'],
        ]),
      );
    },
    TEST_TIMEOUT * 2,
  );
});

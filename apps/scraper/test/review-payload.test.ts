import { parseReviewPayload } from '@vamos/contracts';
import { listScrapedEvents, setSourceEnabled } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyKickoff, promoteFixtures } from '../src/pipeline/promote-fixtures';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  jsonDoc,
  HOUR,
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
      expect(payload).toMatchObject({ eventId: event.id });
      // R-2: the gate's reason, then the teams O1 waits for.
      expect(payload!.reason).toMatch(/^ratings_uncalibrated: Arsenal 0 of \d+ rated matches; /);
    },
    TEST_TIMEOUT,
  );
});

/** The items rule F4 opens (written by the gate, not by hand) have the contract's kickoff_change payload. */
describe('F4 review payload', () => {
  async function createdEvent() {
    h = await createHarness({ calibrated: true });
    h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
    h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
    await h.run('src-a');
    await h.run('src-b');
    expect((await promoteFixtures(h.ctx)).created).toBe(1);
    const { rows } = await h.pool.query<{ id: string }>(
      `SELECT id FROM events WHERE feed_provider = 'scraped'`,
    );
    return rows[0]!.id;
  }
  const openChanges = async () =>
    (
      await h.pool.query<{ severity: string; payload: unknown }>(
        `SELECT severity, payload FROM scrape_review_items WHERE status = 'open' AND kind = 'kickoff_change'`,
      )
    ).rows;
  const moveA = (time: string) => h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, time }]));

  it(
    'F4 an item from the real gate parses with the contract (two sources move to different later times)',
    async () => {
      const eventId = await createdEvent();
      h.advance(HOUR);
      moveA('18:00');
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T19:00:00Z' }]));
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteFixtures(h.ctx)).held).toBe(1);
      const [item] = await openChanges();
      expect(item).toBeDefined();
      const payload = parseReviewPayload('kickoff_change', item!.payload);
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({
        eventId,
        currentKickoff: KICKOFF.toISOString(),
        proposedKickoff: new Date(KICKOFF.getTime() + 3 * HOUR).toISOString(),
        hasBets: false,
      });
      expect(payload!.sources.map((v) => [v.sourceId, v.upstream])).toEqual([
        ['src-a', 'openfootball'],
        ['src-b', 'example-api'],
      ]);
      // The scraper's own fields stay.
      expect(item!.payload).toMatchObject({
        rules: ['F4'],
        reasons: ['sources_disagree'],
        eventStart: KICKOFF.toISOString(),
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'F4 an earlier time is a critical item the contract parses',
    async () => {
      const eventId = await createdEvent();
      h.advance(HOUR);
      moveA('10:00');
      await h.run('src-a');
      await promoteFixtures(h.ctx);
      const [item] = await openChanges();
      expect(item!.severity).toBe('critical');
      expect(parseReviewPayload('kickoff_change', item!.payload)).toMatchObject({
        eventId,
        proposedKickoff: new Date(KICKOFF.getTime() - 5 * HOUR).toISOString(),
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'K4 one source moving later while betting is open: no move, a warning item (betting_open); closed, it moves',
    async () => {
      const eventId = await createdEvent();
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-b', false, { system: 'test' }));
      await h.pool.query(`UPDATE events SET betting_open = true WHERE id = $1`, [eventId]);
      h.advance(HOUR);
      moveA('16:00');
      await h.run('src-a');
      const held = await promoteFixtures(h.ctx);
      expect(held).toMatchObject({ kickoffMoved: 0, held: 1 });
      const [item] = await openChanges();
      expect(item!.severity).toBe('warning');
      expect(item!.payload).toMatchObject({ rules: ['F4'], reasons: ['betting_open'] });
      expect(parseReviewPayload('kickoff_change', item!.payload)).toMatchObject({
        eventId,
        currentKickoff: KICKOFF.toISOString(),
        proposedKickoff: new Date(KICKOFF.getTime() + HOUR).toISOString(),
      });
      const start = async () =>
        (
          await h.pool.query<{ start_time: Date }>(`SELECT start_time FROM events WHERE id = $1`, [
            eventId,
          ])
        ).rows[0]!.start_time;
      expect(new Date(await start())).toEqual(KICKOFF);

      // The same observation with betting closed is moved (F4b).
      await h.pool.query(`UPDATE events SET betting_open = false WHERE id = $1`, [eventId]);
      h.advance(HOUR);
      expect((await promoteFixtures(h.ctx)).kickoffMoved).toBe(1);
      expect(new Date(await start())).toEqual(new Date(KICKOFF.getTime() + HOUR));
    },
    TEST_TIMEOUT,
  );

  it(
    'K4 applyKickoff re-checks betting_open under the row lock for F4b (not for F4a)',
    async () => {
      const eventId = await createdEvent();
      const find = async () =>
        (
          await listScrapedEvents(h.ctx.db, {
            from: new Date(KICKOFF.getTime() - 24 * HOUR),
            to: new Date(KICKOFF.getTime() + 24 * HOUR),
          })
        ).find((e) => e.eventId === eventId)!;
      const decision = (rule: 'F4a' | 'F4b', to: number) => ({
        action: 'update-kickoff' as const,
        eventId,
        feedRef: '',
        from: KICKOFF,
        to: new Date(KICKOFF.getTime() + to),
        rule,
        upstreams: ['openfootball'],
      });
      const event = await find();
      const now = h.now();
      await h.pool.query(`UPDATE events SET betting_open = true WHERE id = $1`, [eventId]);
      // The decision was taken on a snapshot that said betting was closed.
      const refused = await applyKickoff(
        h.ctx,
        { ...decision('F4b', HOUR), feedRef: event.feedRef },
        event,
        now,
      );
      expect(refused).toEqual({ moved: false, messages: [] });
      expect(
        await h.count(
          `SELECT count(*) AS n FROM events WHERE id = '${eventId}' AND start_time = '${KICKOFF.toISOString()}'`,
        ),
      ).toBe(1);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.fixture.kickoff_moved'`,
        ),
      ).toBe(0);
      // F4a (two independent upstreams) still applies with betting open.
      const applied = await applyKickoff(
        h.ctx,
        { ...decision('F4a', HOUR), feedRef: event.feedRef },
        event,
        now,
      );
      expect(applied.moved).toBe(true);
    },
    TEST_TIMEOUT,
  );
});

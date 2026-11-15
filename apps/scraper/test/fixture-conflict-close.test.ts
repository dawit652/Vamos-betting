import { openReviewItem, setCompetitionPolicy } from '@vamos/db';
import { buildReviews } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
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
  type JsonEvent,
  type OfMatch,
} from './helpers';

/**
 * Rule F6c (docs/scraper.md 6.1): a fixture_conflict raised because the sources disagreed closes by
 * itself once they agree again on two consecutive promotion passes. The streak lives in the item's
 * payload (`agreedPasses`), so it survives a restart and restarts whenever the conflict is raised
 * again. `feed_ref_exists` needs a person and never closes this way. Closing touches nothing else.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const RESOLUTION = 'auto: sources agree again (2 passes)';

interface ItemRow {
  id: string;
  subject_key: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  payload: Record<string, unknown>;
}
const conflictItems = async (): Promise<ItemRow[]> =>
  (
    await h.pool.query<ItemRow>(
      `SELECT id, subject_key, status, resolution, resolved_by, payload FROM scrape_review_items
        WHERE kind = 'fixture_conflict' ORDER BY created_at, id`,
    )
  ).rows;
const audits = async (action: string) =>
  (
    await h.pool.query<{ target_id: string; metadata: Record<string, unknown> }>(
      `SELECT target_id, metadata FROM audit_log WHERE action = $1 ORDER BY created_at`,
      [action],
    )
  ).rows;
interface EventRow {
  feed_ref: string;
  start_time: Date;
  status: string;
  betting_open: boolean;
}
const scrapedEvents = async (): Promise<EventRow[]> =>
  (
    await h.pool.query<EventRow>(
      `SELECT feed_ref, start_time, status, betting_open FROM events
        WHERE feed_provider = 'scraped' ORDER BY feed_ref`,
    )
  ).rows;
const prices = async () =>
  (
    await h.pool.query<{ id: string; odds_milli: number; status: string }>(
      `SELECT s.id, s.odds_milli, s.status FROM selections s
         JOIN markets m ON m.id = s.market_id
         JOIN events e ON e.id = m.event_id
        WHERE e.feed_provider = 'scraped' ORDER BY s.id`,
    )
  ).rows;

/** Both sources publish what they say now, and one promotion pass runs. */
async function pass(of: OfMatch, json: JsonEvent) {
  h.advance(MINUTE);
  h.serve(URL_A, ofDoc([of]));
  h.serve(URL_B, jsonDoc([json]));
  await h.run('src-a');
  await h.run('src-b');
  return promoteFixtures(h.ctx);
}

const AGREE = [ARSENAL_CHELSEA_OF, ARSENAL_CHELSEA_JSON] as const;
const LATER_B: JsonEvent = { ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T17:00:00Z' };
const POSTPONED_B: JsonEvent = { ...ARSENAL_CHELSEA_JSON, st: 'PST' };
const SUBJECT_SUFFIX = '|2026-11-02';

describe('F6c: a fixture_conflict closes once the sources agree for two passes', () => {
  it(
    'kickoff_disagreement: one agreeing pass keeps it open, the second closes it with an audit row',
    async () => {
      h = await createHarness();
      // The sources give kickoffs two hours apart: nothing is created, a person is asked.
      let summary = await pass(ARSENAL_CHELSEA_OF, LATER_B);
      expect(summary).toMatchObject({ created: 0, held: 1, conflictItemsClosed: 0 });
      const [raised] = await conflictItems();
      expect(raised).toMatchObject({
        status: 'open',
        payload: { reasons: ['kickoff_disagreement'] },
      });
      expect(raised!.subject_key.endsWith(SUBJECT_SUFFIX)).toBe(true);
      expect(raised!.payload.agreedPasses).toBeUndefined();

      // First agreeing pass: the fixture is created (F2); the item stays open and counts one pass.
      summary = await pass(...AGREE);
      expect(summary).toMatchObject({ created: 1, conflictItemsClosed: 0 });
      expect(await conflictItems()).toMatchObject([
        { id: raised!.id, status: 'open', payload: { agreedPasses: 1 } },
      ]);
      const [event] = await scrapedEvents();
      expect(event!.feed_ref).toBe(raised!.subject_key);
      const pricesBefore = await prices();
      expect(pricesBefore.length).toBeGreaterThan(0);

      // Second agreeing pass (the event is unchanged): the item closes, nothing else moves.
      summary = await pass(...AGREE);
      expect(summary).toMatchObject({
        created: 0,
        kickoffMoved: 0,
        held: 0,
        conflictItemsClosed: 1,
        failed: 0,
      });
      expect(await conflictItems()).toMatchObject([
        {
          id: raised!.id,
          status: 'resolved',
          resolution: RESOLUTION,
          resolved_by: 'system:scraper',
        },
      ]);
      expect(await scrapedEvents()).toEqual([event]);
      expect(await prices()).toEqual(pricesBefore);
      expect(await audits('scrape.review.agreed')).toEqual([
        {
          target_id: raised!.id,
          metadata: {
            kind: 'fixture_conflict',
            subjectKey: raised!.subject_key,
            rule: 'F6c',
            reasons: ['kickoff_disagreement'],
            agreedPasses: 2,
          },
        },
      ]);
      expect(await audits('scrape.review.resolved')).toMatchObject([
        { target_id: raised!.id, metadata: { resolution: RESOLUTION } },
      ]);

      // Nothing is left to close on the next pass.
      expect((await pass(...AGREE)).conflictItemsClosed).toBe(0);
      expect(await audits('scrape.review.agreed')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'status_disagreement in shadow mode: disagreeing again in between restarts the streak',
    async () => {
      h = await createHarness();
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: false }, { system: 'test' }),
      );
      await pass(ARSENAL_CHELSEA_OF, POSTPONED_B);
      const [raised] = await conflictItems();
      expect(raised).toMatchObject({
        status: 'open',
        payload: { reasons: ['status_disagreement'] },
      });

      // Agreeing (only the switched-off policy keeps it from being created): one pass counted.
      await pass(...AGREE);
      expect((await conflictItems())[0]!.payload.agreedPasses).toBe(1);

      // The source says postponed again: the conflict is raised again and its streak is gone.
      expect((await pass(ARSENAL_CHELSEA_OF, POSTPONED_B)).conflictItemsClosed).toBe(0);
      const [again] = await conflictItems();
      expect(again).toMatchObject({ id: raised!.id, status: 'open' });
      expect(again!.payload.agreedPasses).toBeUndefined();

      // One agreeing pass after that is not enough ...
      expect((await pass(...AGREE)).conflictItemsClosed).toBe(0);
      expect(await conflictItems()).toMatchObject([
        { id: raised!.id, status: 'open', payload: { agreedPasses: 1 } },
      ]);
      // ... the second consecutive one closes it.
      expect((await pass(...AGREE)).conflictItemsClosed).toBe(1);
      expect(await conflictItems()).toMatchObject([
        { id: raised!.id, status: 'resolved', resolution: RESOLUTION },
      ]);
      expect(await audits('scrape.review.agreed')).toHaveLength(1);
      expect(await scrapedEvents()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'sources_disagree (several clusters): closes when the sources settle on the other day',
    async () => {
      h = await createHarness();
      const thursday: OfMatch = { ...ARSENAL_CHELSEA_OF, date: '2026-11-05' };
      const thursdayB: JsonEvent = { ...ARSENAL_CHELSEA_JSON, kick: '2026-11-05T15:00:00Z' };
      // Three days apart (more than the cluster window): two clusters of one unknown fixture.
      await pass(thursday, ARSENAL_CHELSEA_JSON);
      const [raised] = await conflictItems();
      expect(raised).toMatchObject({ status: 'open', payload: { reasons: ['sources_disagree'] } });
      expect(raised!.subject_key.endsWith(SUBJECT_SUFFIX)).toBe(true);

      // Both now say Thursday: the event is created under Thursday's key, another subject.
      expect((await pass(thursday, thursdayB)).created).toBe(1);
      expect((await scrapedEvents()).map((e) => e.feed_ref.slice(-10))).toEqual(['2026-11-05']);
      expect((await conflictItems())[0]!.payload.agreedPasses).toBe(1);
      expect((await pass(thursday, thursdayB)).conflictItemsClosed).toBe(1);
      expect(await conflictItems()).toMatchObject([
        { id: raised!.id, status: 'resolved', resolution: RESOLUTION },
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'feed_ref_exists is never closed this way, however long the sources agree',
    async () => {
      h = await createHarness();
      expect((await pass(...AGREE)).created).toBe(1);
      const [event] = await scrapedEvents();
      const [review] = buildReviews(
        event!.feed_ref,
        [{ kind: 'fixture_conflict', rule: 'F3', reason: 'feed_ref_exists' }],
        () => ({ feedRef: event!.feed_ref, eventId: null }),
      );
      await h.ctx.db.transaction((tx) =>
        openReviewItem(tx, { ...review!, payload: { ...review!.payload }, now: h.now() }),
      );

      for (let i = 0; i < 3; i += 1) {
        expect((await pass(...AGREE)).conflictItemsClosed).toBe(0);
      }
      const [item] = await conflictItems();
      expect(item).toMatchObject({
        subject_key: event!.feed_ref,
        status: 'open',
        resolution: null,
        payload: { reasons: ['feed_ref_exists'] },
      });
      expect(item!.payload.agreedPasses).toBeUndefined();
      expect(await audits('scrape.review.agreed')).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

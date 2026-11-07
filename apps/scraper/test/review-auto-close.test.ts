import { setSourceEnabled } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
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
} from './helpers';

/**
 * F5 and F1 to F3 (docs/scraper.md): `fixture_missing` and `fixture_conflict` items close by
 * themselves once their cause is gone, and a match that has kicked off is never "missing".
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const SYSTEM = { system: 'test' };

interface ItemRow {
  kind: string;
  status: string;
  resolution: string | null;
  resolved_by: string | null;
}
const itemsOf = async (kind: string): Promise<ItemRow[]> =>
  (
    await h.pool.query<ItemRow>(
      `SELECT kind, status, resolution, resolved_by FROM scrape_review_items
        WHERE kind = $1 ORDER BY created_at, id`,
      [kind],
    )
  ).rows;
const scrapedEvents = () =>
  h.count(`SELECT count(*) AS n FROM events WHERE feed_provider = 'scraped'`);
const enable = (sourceId: string, on: boolean) =>
  h.ctx.db.transaction((tx) => setSourceEnabled(tx, sourceId, on, SYSTEM));

/** Both sources list the fixture; promotion creates the event. */
async function createdEvent(): Promise<void> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

/** No enabled source lists the match any more: F5 flags it. */
async function noSourceListsIt(): Promise<void> {
  await enable('src-a', false);
  await enable('src-b', false);
  h.advance(MINUTE);
  expect((await promoteFixtures(h.ctx)).missing).toBe(1);
  expect(await itemsOf('fixture_missing')).toMatchObject([{ status: 'open' }]);
}

describe('F5: fixture_missing closes by itself', () => {
  it(
    'closes once a source lists the match again',
    async () => {
      await createdEvent();
      await noSourceListsIt();
      await enable('src-b', true);
      h.advance(MINUTE);
      const summary = await promoteFixtures(h.ctx);
      expect(summary).toMatchObject({ missing: 0, missingClosed: 1 });
      expect(await itemsOf('fixture_missing')).toEqual([
        {
          kind: 'fixture_missing',
          status: 'resolved',
          resolution: 'a source lists the match again',
          resolved_by: 'system:scraper',
        },
      ]);
      expect((await promoteFixtures(h.ctx)).missingClosed).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'closes at kickoff, and a match that has kicked off is never flagged again',
    async () => {
      await createdEvent();
      await noSourceListsIt();
      h.at(new Date(KICKOFF.getTime() + HOUR));
      expect(await promoteFixtures(h.ctx)).toMatchObject({ missing: 0, missingClosed: 1 });
      expect(await itemsOf('fixture_missing')).toMatchObject([
        {
          status: 'resolved',
          resolution: 'the match has kicked off: its result decides from here',
        },
      ]);
      // Two days on, still unresulted and still listed by nobody: no new item.
      h.at(new Date(KICKOFF.getTime() + 50 * HOUR));
      expect(await promoteFixtures(h.ctx)).toMatchObject({ missing: 0, missingClosed: 0 });
      expect(await itemsOf('fixture_missing')).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});

describe('F1 to F3: fixture_conflict closes by itself', () => {
  it(
    'a kickoff disagreement on a new fixture closes once the sources agree and the event is created',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T17:00:00Z' }]));
      await h.run('src-a');
      await h.run('src-b');
      expect(await promoteFixtures(h.ctx)).toMatchObject({ created: 0, held: 1 });
      expect(await scrapedEvents()).toBe(0);
      expect(await itemsOf('fixture_conflict')).toMatchObject([{ status: 'open' }]);

      // The same disagreement on the next pass refreshes the item; nothing closes.
      h.advance(MINUTE);
      expect(await promoteFixtures(h.ctx)).toMatchObject({ held: 1, conflictsClosed: 0 });
      expect(await itemsOf('fixture_conflict')).toMatchObject([{ status: 'open' }]);

      // The second source corrects its kickoff: the event is created and the conflict is gone.
      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await h.run('src-b');
      expect(await promoteFixtures(h.ctx)).toMatchObject({ created: 1, conflictsClosed: 1 });
      expect(await scrapedEvents()).toBe(1);
      expect(await itemsOf('fixture_conflict')).toEqual([
        {
          kind: 'fixture_conflict',
          status: 'resolved',
          resolution: 'the sources no longer conflict: the fixture pass does not raise it again',
          resolved_by: 'system:scraper',
        },
      ]);
    },
    TEST_TIMEOUT,
  );
});

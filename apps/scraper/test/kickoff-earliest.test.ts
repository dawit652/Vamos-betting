import { loadKickoffEvidence, openReviewItem, setCompetitionPolicy } from '@vamos/db';
import {
  assessKickoff,
  KICKOFF_EVIDENCE_WINDOW_MS,
  MIN_MATCH_DURATION_MS,
  SOURCE_STALE_AFTER_MS,
} from '@vamos/scraper';
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
  type JsonEvent,
  type OfMatch,
} from './helpers';

/**
 * Rule F4d (the owner's decision D3, 23 Nov 2026; docs/plans/review-queue-automation.md, step 3):
 * when the sources disagree about a kickoff, the earliest kickoff a fresh source lists answers it,
 * and K2 no longer lets a later statement block the confirmation. Moving later stays with F4a or a
 * person; a switched-off competition and a time too close stay with a person.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
}, SETUP_TIMEOUT);

const EARLIER = new Date('2026-11-02T13:00:00Z');
const SYSTEM = { system: 'test' };
/** A finished match in both sources, so each is known and fresh (docs/scraper.md 6.1a). */
const OLD_OF: OfMatch = {
  date: '2026-10-25',
  time: '15:00',
  team1: 'Liverpool FC',
  team2: 'Everton FC',
  score: { ht: [0, 0], ft: [1, 0] },
};
const OLD_JSON: JsonEvent = {
  id: 3,
  kick: '2026-10-25T15:00:00Z',
  h: 'Liverpool',
  a: 'Everton',
  st: 'FT',
  hs: '1',
  as: '0',
  hth: '0',
  hta: '0',
};

interface ItemRow {
  subject_key: string;
  status: string;
  resolution: string | null;
}
const kickoffItems = async (): Promise<ItemRow[]> =>
  (
    await h.pool.query<ItemRow>(
      `SELECT subject_key, status, resolution FROM scrape_review_items
        WHERE kind = 'kickoff_change' ORDER BY subject_key, created_at`,
    )
  ).rows;
const event = async () =>
  (
    await h.pool.query<{ id: string; start_time: Date; feed_ref: string }>(
      `SELECT id, start_time, feed_ref FROM events WHERE feed_provider = 'scraped'`,
    )
  ).rows[0]!;
const moves = async () =>
  (
    await h.pool.query<{ rule: string; from: string; to: string }>(
      `SELECT metadata->>'rule' AS rule, metadata->>'from' AS "from", metadata->>'to' AS "to"
         FROM audit_log WHERE action = 'scrape.fixture.kickoff_moved' ORDER BY id`,
    )
  ).rows;

/** K2 at the harness clock, as the API and F7b assess it. */
async function assessNow(eventId: string) {
  const evidence = (
    await loadKickoffEvidence(h.ctx.db, {
      eventIds: [eventId],
      now: h.now(),
      minMatchDurationMs: MIN_MATCH_DURATION_MS,
      staleAfterMs: SOURCE_STALE_AFTER_MS,
      evidenceWindowMs: KICKOFF_EVIDENCE_WINDOW_MS,
    })
  ).get(eventId)!;
  return assessKickoff({
    start: evidence.event.startTime,
    now: h.now(),
    statements: evidence.statements,
    person: evidence.person,
  });
}

/** Both sources list the fixture at 15:00; promotion creates the event (betting closed). */
async function createdEvent(): Promise<void> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([OLD_OF, ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([OLD_JSON, ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

/** src-a (openfootball, keyed by date) now gives another time; src-b keeps 15:00. */
async function srcASays(match: OfMatch) {
  h.advance(MINUTE);
  h.serve(URL_A, ofDoc([OLD_OF, match]));
  await h.run('src-a');
  return promoteFixtures(h.ctx);
}

describe('F4d: a kickoff disagreement is answered by the earliest fresh kickoff (D3)', () => {
  it(
    'a fresh source says two hours earlier: the event moves there, and K2 confirms it a day later (C2)',
    async () => {
      await createdEvent();
      const summary = await srcASays({ ...ARSENAL_CHELSEA_OF, time: '13:00' });
      expect(summary).toMatchObject({ kickoffMoved: 1, held: 0 });
      const row = await event();
      expect(row.start_time).toEqual(EARLIER);
      expect(await moves()).toEqual([
        { rule: 'F4d', from: KICKOFF.toISOString(), to: EARLIER.toISOString() },
      ]);
      expect(await kickoffItems()).toEqual([]);

      // src-b's 15:00 is later than the new start: named while unconfirmed, it no longer blocks K2.
      expect(await assessNow(row.id)).toMatchObject({
        confirmed: false,
        reasons: ['not_stable', 'sources_disagree'],
      });
      h.advance(25 * HOUR);
      expect(await assessNow(row.id)).toMatchObject({ confirmed: true, basis: 'C2' });
      // A second pass changes nothing.
      expect(await promoteFixtures(h.ctx)).toMatchObject({ kickoffMoved: 0, held: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'a fresh source says later: the start is kept, an open item closes, and K2 confirms on the other source',
    async () => {
      await createdEvent();
      const { feed_ref: feedRef, id } = await event();
      // The item a pass raised before F4d existed.
      await h.ctx.db.transaction((tx) =>
        openReviewItem(tx, {
          kind: 'kickoff_change',
          subjectKey: feedRef,
          severity: 'warning',
          title: 'Kickoff change proposed',
          payload: { reasons: ['sources_disagree'] },
          now: h.now(),
        }),
      );
      const summary = await srcASays({ ...ARSENAL_CHELSEA_OF, time: '17:00' });
      expect(summary).toMatchObject({ kickoffMoved: 0, held: 0, kickoffItemsClosed: 1 });
      expect((await event()).start_time).toEqual(KICKOFF);
      expect(await kickoffItems()).toEqual([
        {
          subject_key: feedRef,
          status: 'resolved',
          resolution: 'the event starts at the earliest kickoff a fresh source gives (F4d)',
        },
      ]);
      h.advance(25 * HOUR);
      expect(await assessNow(id)).toMatchObject({ confirmed: true, basis: 'C2' });
    },
    TEST_TIMEOUT,
  );

  it(
    'openfootball moves the match to the next day: its old row is no longer listed, so it neither holds nor moves the event',
    async () => {
      await createdEvent();
      // The old row (2 Nov) stays current but unlisted; the new one (3 Nov) is later than the start.
      const summary = await srcASays({ ...ARSENAL_CHELSEA_OF, date: '2026-11-03' });
      expect(summary).toMatchObject({ kickoffMoved: 0, held: 0 });
      expect((await event()).start_time).toEqual(KICKOFF);
      expect(await kickoffItems()).toEqual([]);

      // Once src-b moves too, every fresh source says later: a later move is not F4d's.
      h.advance(MINUTE);
      h.serve(
        URL_B,
        jsonDoc([OLD_JSON, { ...ARSENAL_CHELSEA_JSON, kick: '2026-11-03T15:00:00Z' }]),
      );
      await h.run('src-b');
      const after = await promoteFixtures(h.ctx);
      expect(after.kickoffMoved).toBe(0);
      expect((await event()).start_time).toEqual(KICKOFF);
      expect(await kickoffItems()).toMatchObject([{ status: 'open' }]);
    },
    TEST_TIMEOUT,
  );

  it(
    'a switched-off competition is never moved: a person decides (S4)',
    async () => {
      await createdEvent();
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: false }, SYSTEM),
      );
      const summary = await srcASays({ ...ARSENAL_CHELSEA_OF, time: '13:00' });
      expect(summary).toMatchObject({ kickoffMoved: 0, held: 1 });
      expect((await event()).start_time).toEqual(KICKOFF);
      expect(await kickoffItems()).toMatchObject([{ status: 'open' }]);
    },
    TEST_TIMEOUT,
  );

  it(
    'an earlier time within the lead (10 minutes from now) is never applied: a person decides',
    async () => {
      await createdEvent();
      h.at(new Date(EARLIER.getTime() - 5 * MINUTE));
      await h.run('src-b');
      const summary = await srcASays({ ...ARSENAL_CHELSEA_OF, time: '13:00' });
      expect(summary).toMatchObject({ kickoffMoved: 0, held: 1 });
      expect((await event()).start_time).toEqual(KICKOFF);
      expect(await kickoffItems()).toMatchObject([{ status: 'open' }]);
    },
    TEST_TIMEOUT,
  );
});

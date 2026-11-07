import {
  resolveReviewItem,
  setCompetitionPolicy,
  setEventBettingOpen,
  setSourceEnabled,
} from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfirmedEvents } from '../src/pipeline/auto-open';
import { closeBettingOnEarlierKickoff } from '../src/pipeline/kickoff-safety';
import { runPromotion } from '../src/tasks/promote';
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
  type HarnessOptions,
  type JsonEvent,
  type OfMatch,
} from './helpers';

/**
 * Rule F7b (docs/scraper.md): openConfirmedEvents opens betting on a scraped event that was created
 * closed (F7) or closed by K1 once its kickoff is confirmed (K2) and nobody decided otherwise.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const SYSTEM = { system: 'test' };
const STAFF = { adminId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d' };
const RESOLUTION =
  'betting opened automatically: auto open is on and the kickoff is confirmed (F7b)';

const rows = async <T = Record<string, unknown>>(query: string, params: unknown[] = []) =>
  (await h.pool.query<T>(query, params)).rows;

/** A match that ended long ago: it makes the source's freshness known. */
const OLD_OF: OfMatch = {
  date: '2026-10-25',
  time: '15:00',
  team1: 'Liverpool FC',
  team2: 'Everton FC',
  score: { ht: [0, 0], ft: [1, 0] },
};
const MOVED_EARLIER: OfMatch = { ...ARSENAL_CHELSEA_OF, date: '2026-11-01', time: '20:00' };
/** Within the 72 h lead window and more than 24 h after the source last changed. */
const CONFIRMED_AT = new Date(KICKOFF.getTime() - 71 * HOUR);

async function start(options: HarnessOptions & { autoOpen?: boolean } = {}): Promise<void> {
  h = await createHarness(options);
  await h.ctx.db.transaction(async (tx) => {
    await setCompetitionPolicy(tx, h.premier, { autoOpen: options.autoOpen ?? true }, SYSTEM);
    await setSourceEnabled(tx, 'src-b', false, SYSTEM);
  });
}

/** One promotion pass creates the event: closed, with an odds_approval item. */
async function createdEvent(): Promise<string> {
  h.serve(URL_A, ofDoc([OLD_OF, ARSENAL_CHELSEA_OF]));
  await h.run('src-a');
  await runPromotion(h.ctx);
  return (
    await rows<{ id: string }>(
      `SELECT id FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1`,
      [h.team('Arsenal')],
    )
  )[0]!.id;
}

const bettingOpen = async (id: string) =>
  (await rows<{ betting_open: boolean }>(`SELECT betting_open FROM events WHERE id = $1`, [id]))[0]!
    .betting_open;

const items = (where = `1 = 1`) =>
  rows<{
    id: string;
    kind: string;
    subject_key: string;
    status: string;
    resolved_by: string | null;
    resolution: string | null;
  }>(
    `SELECT id, kind, subject_key, status, resolved_by, resolution FROM scrape_review_items
      WHERE ${where} ORDER BY created_at, id`,
  );

const openedAudits = () =>
  rows<{ target_id: string; actor_id: string; metadata: Record<string, unknown> }>(
    `SELECT target_id, actor_id, metadata FROM audit_log WHERE action = 'scrape.fixture.betting_opened'`,
  );

/** The sample fixture's kickoff is confirmed by C2: inside 72 h, one fresh source unchanged for 24 h. */
async function confirmByC2(): Promise<void> {
  h.at(CONFIRMED_AT);
  await h.run('src-a');
}

const person = (eventId: string, open: boolean) =>
  h.ctx.db.transaction((tx) => setEventBettingOpen(tx, eventId, open, STAFF));

describe('F7b: automatic opening of a closed event whose kickoff is confirmed', () => {
  it(
    'opens an event created closed once the kickoff is confirmed, resolves its item, audits it, and is idempotent',
    async () => {
      await start();
      const eventId = await createdEvent();
      expect(await bettingOpen(eventId)).toBe(false);
      const [item] = await items(`kind = 'odds_approval' AND status = 'open'`);
      expect(item).toBeDefined();

      // 73 h before kickoff the single source cannot confirm yet.
      h.at(new Date(KICKOFF.getTime() - 73 * HOUR));
      await h.run('src-a');
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 0, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(false);
      expect(await openedAudits()).toHaveLength(0);

      await confirmByC2();
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(true);

      const [after] = await items(`id = '${item!.id}'`);
      expect(after).toMatchObject({
        status: 'resolved',
        resolved_by: 'system:scraper',
        resolution: RESOLUTION,
      });
      const audits = await openedAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ target_id: eventId, actor_id: 'system:scraper' });
      expect(audits[0]!.metadata).toMatchObject({
        rule: 'F7b',
        afterK1: false,
        basis: 'C2',
        start: KICKOFF.toISOString(),
      });

      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 0, opened: 0 });
      expect(await openedAudits()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'runPromotion runs it as its last step',
    async () => {
      await start();
      const eventId = await createdEvent();
      await confirmByC2();
      await runPromotion(h.ctx);
      expect(await bettingOpen(eventId)).toBe(true);
      expect(await openedAudits()).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'does nothing when the competition policy has auto_open off, even when confirmed',
    async () => {
      await start({ autoOpen: false });
      const eventId = await createdEvent();
      const [item] = await items(`kind = 'odds_approval'`);
      expect(item!.status).toBe('open');
      await confirmByC2();
      expect(await openConfirmedEvents(h.ctx)).toEqual({
        checked: 0,
        opened: 0,
        failed: 0,
        published: 0,
      });
      expect(await bettingOpen(eventId)).toBe(false);
      expect((await items(`id = '${item!.id}'`))[0]!.status).toBe('open');
      expect(await openedAudits()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'a person who opened and then closed betting keeps it closed, with an odds_approval item open',
    async () => {
      await start();
      const eventId = await createdEvent();
      await person(eventId, true);
      await person(eventId, false);
      const [item] = await items(`kind = 'odds_approval'`);
      expect(item!.status).toBe('open');
      await confirmByC2();
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 0, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(false);
      expect(await openedAudits()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  for (const status of ['resolved', 'dismissed'] as const) {
    it(
      `a person who ${status === 'resolved' ? 'resolved' : 'dismissed'} the odds_approval item keeps betting closed`,
      async () => {
        await start();
        const eventId = await createdEvent();
        const [item] = await items(`kind = 'odds_approval' AND status = 'open'`);
        await h.ctx.db.transaction((tx) =>
          resolveReviewItem(tx, item!.id, {
            status,
            resolution: 'trader decided',
            actor: STAFF,
            now: h.now(),
          }),
        );
        await confirmByC2();
        expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 0, opened: 0 });
        expect(await bettingOpen(eventId)).toBe(false);
        expect(await openedAudits()).toHaveLength(0);
      },
      TEST_TIMEOUT,
    );
  }

  it(
    'K1 then recovery: nothing opens while the earlier report is listed; afterwards betting opens, the |earlier item is resolved, afterK1 is true',
    async () => {
      await start();
      const eventId = await createdEvent();
      await person(eventId, true);
      expect(await bettingOpen(eventId)).toBe(true);

      h.advance(HOUR);
      h.serve(URL_A, ofDoc([OLD_OF, MOVED_EARLIER]));
      await h.run('src-a');
      expect(await closeBettingOnEarlierKickoff(h.ctx)).toMatchObject({ closed: 1 });
      expect(await bettingOpen(eventId)).toBe(false);
      const [earlier] = await items(`subject_key LIKE '%|earlier'`);
      expect(earlier).toMatchObject({ kind: 'kickoff_change', status: 'open' });

      // Even deep inside the lead window, the listed earlier report keeps it closed.
      h.at(CONFIRMED_AT);
      await h.run('src-a');
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 0, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(false);

      // The source reports the event's own time again; it is unchanged for 24 h by then.
      h.serve(URL_A, ofDoc([OLD_OF, ARSENAL_CHELSEA_OF]));
      await h.run('src-a');
      h.advance(25 * HOUR);
      await h.run('src-a');
      expect(h.now().getTime()).toBeLessThan(KICKOFF.getTime() - 20 * HOUR);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(true);

      expect((await items(`id = '${earlier!.id}'`))[0]).toMatchObject({
        status: 'resolved',
        resolved_by: 'system:scraper',
        resolution: RESOLUTION,
      });
      const audits = await openedAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({ rule: 'F7b', afterK1: true });
    },
    TEST_TIMEOUT,
  );

  it(
    'K1 then the source is disabled: the earlier report no longer counts; a person record (C3) after it lets F7b open betting',
    async () => {
      await start();
      const eventId = await createdEvent();
      await person(eventId, true);
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([OLD_OF, MOVED_EARLIER]));
      await h.run('src-a');
      await closeBettingOnEarlierKickoff(h.ctx);
      expect(await bettingOpen(eventId)).toBe(false);
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 0 });

      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-a', false, SYSTEM));
      h.advance(HOUR);
      await h.pool.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata, created_at)
         VALUES ('admin', $1, 'scrape.fixture.kickoff_confirmed', 'event', $2, $3::jsonb, $4)`,
        [
          STAFF.adminId,
          eventId,
          JSON.stringify({ startTime: KICKOFF.toISOString(), evidenceKey: 'a'.repeat(64) }),
          h.now(),
        ],
      );
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(true);
      expect((await openedAudits())[0]!.metadata).toMatchObject({ afterK1: true, basis: 'C3' });
      expect((await items(`subject_key LIKE '%|earlier'`))[0]).toMatchObject({
        status: 'resolved',
        resolved_by: 'system:scraper',
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'stays closed when the event starts within MIN_LEAD_MS',
    async () => {
      await start();
      const eventId = await createdEvent();
      await confirmByC2();
      h.at(new Date(KICKOFF.getTime() - 5 * MINUTE));
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 0, opened: 0 });
      expect(await bettingOpen(eventId)).toBe(false);
      expect(await openedAudits()).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'an open F4 kickoff_change item for the event blocks the opening',
    async () => {
      await start();
      const eventId = await createdEvent();
      const [eventRow] = await rows<{ feed_ref: string }>(
        `SELECT feed_ref FROM events WHERE id = $1`,
        [eventId],
      );
      await h.pool.query(
        `INSERT INTO scrape_review_items (kind, subject_key, severity, title, payload)
         VALUES ('kickoff_change', $1, 'warning', 'sources disagree', '{}'::jsonb)`,
        [eventRow!.feed_ref],
      );
      await confirmByC2();
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 0, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(false);

      await h.pool.query(
        `UPDATE scrape_review_items SET status = 'dismissed', resolved_at = now()
          WHERE kind = 'kickoff_change' AND subject_key = $1`,
        [eventRow!.feed_ref],
      );
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1 });
      expect(await bettingOpen(eventId)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'an open re-price proposal blocks the opening until a person decides on the prices',
    async () => {
      await start();
      const eventId = await createdEvent();
      const [eventRow] = await rows<{ feed_ref: string }>(
        `SELECT feed_ref FROM events WHERE id = $1`,
        [eventId],
      );
      const subject = `${eventRow!.feed_ref}|reprice`;
      await h.pool.query(
        `INSERT INTO scrape_review_items (kind, subject_key, severity, title, payload)
         VALUES ('odds_approval', $1, 'warning', 'prices moved too far', '{}'::jsonb)`,
        [subject],
      );
      await confirmByC2();
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 0, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(false);

      await h.pool.query(
        `UPDATE scrape_review_items SET status = 'dismissed', resolved_at = now()
          WHERE kind = 'odds_approval' AND subject_key = $1`,
        [subject],
      );
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ opened: 1 });
      expect(await bettingOpen(eventId)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    'a team that is no longer calibrated blocks the opening (O1)',
    async () => {
      await start();
      const eventId = await createdEvent();
      // Created with calibrated teams (an odds_approval item); then Chelsea's ratings lose their matches.
      await h.pool.query(
        `UPDATE teams SET ratings = '{"attack":1.2,"defence":0.9,"matches":0}'::jsonb WHERE id = $1`,
        [h.team('Chelsea')],
      );
      await confirmByC2();
      expect(await openConfirmedEvents(h.ctx)).toMatchObject({ checked: 1, opened: 0, failed: 0 });
      expect(await bettingOpen(eventId)).toBe(false);
      expect(await openedAudits()).toHaveLength(0);
      expect((await items(`kind = 'odds_approval'`))[0]!.status).toBe('open');
    },
    TEST_TIMEOUT,
  );

  it(
    'production case: an outdated source reports an earlier kickoff (K1); once it is disabled the other source confirms (C2) and the next pass opens betting again',
    async () => {
      h = await createHarness();
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { autoOpen: true }, SYSTEM),
      );
      const oldJson: JsonEvent = {
        id: 99,
        kick: '2026-10-25T15:00:00Z',
        h: 'Liverpool',
        a: 'Everton',
        st: 'FT',
        hs: '1',
        as: '0',
        hth: '0',
        hta: '0',
      };
      h.serve(URL_A, ofDoc([OLD_OF, ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([oldJson, ARSENAL_CHELSEA_JSON]));
      await h.run('src-a');
      await h.run('src-b');
      await runPromotion(h.ctx);
      const [created] = await rows<{ id: string; feed_ref: string }>(
        `SELECT id, feed_ref FROM events WHERE feed_provider = 'scraped' AND home_team_id = $1`,
        [h.team('Arsenal')],
      );
      const eventId = created!.id;
      // Two fresh independent upstreams agree (C1): F7 opened betting at creation.
      expect(await bettingOpen(eventId)).toBe(true);

      // The outdated source still has an earlier kickoff: K1 closes betting.
      h.advance(HOUR);
      h.serve(URL_A, ofDoc([OLD_OF, MOVED_EARLIER]));
      await h.run('src-a');
      await runPromotion(h.ctx);
      expect(await bettingOpen(eventId)).toBe(false);
      expect(
        await items(`subject_key = '${created!.feed_ref}|earlier' AND status = 'open'`),
      ).toHaveLength(1);

      // A person switches the outdated source off; inside 72 h the other source confirms alone (C2).
      await h.ctx.db.transaction((tx) => setSourceEnabled(tx, 'src-a', false, SYSTEM));
      h.at(CONFIRMED_AT);
      await h.run('src-b');
      await runPromotion(h.ctx);
      expect(await bettingOpen(eventId)).toBe(true);
      expect(
        await items(
          `kind = 'kickoff_change' AND status = 'open' AND subject_key LIKE '${created!.feed_ref}%'`,
        ),
      ).toHaveLength(0);
      const audits = await openedAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({ rule: 'F7b', afterK1: true, basis: 'C2' });
    },
    TEST_TIMEOUT,
  );
});

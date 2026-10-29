import { randomUUID } from 'node:crypto';
import {
  listScrapedEvents,
  resolveReviewItem,
  setCompetitionPolicy,
  setSourceEnabled,
  upsertSource,
} from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { applyKickoff, promoteFixtures } from '../src/pipeline/promote-fixtures';
import { applyStaffConfirmations, promoteResults } from '../src/pipeline/promote-results';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  finishedJson,
  finishedOf,
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
 * Regression tests for the independent review of 2026-10 (docs/scraper-plan/review-2026-10.md).
 * Each describe block is one finding.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const DAY = 24 * HOUR;
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await h.pool.query<T>(sql, params)).rows;
const event = async () =>
  (
    await rows<{
      status: string;
      start_time: Date;
      score_home: number | null;
      score_away: number | null;
    }>(
      `SELECT status, start_time, score_home, score_away FROM events WHERE feed_provider = 'scraped'`,
    )
  )[0]!;
const openKinds = async () =>
  (await rows<{ kind: string }>(`SELECT kind FROM scrape_review_items WHERE status = 'open'`)).map(
    (r) => r.kind,
  );

/** Both sources list the fixture; promotion creates the event. */
async function createdEvent(options: { autoResults?: boolean } = {}): Promise<void> {
  h = await createHarness(options);
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

const switchOff = () =>
  h.ctx.db.transaction((tx) =>
    setCompetitionPolicy(tx, h.premier, { enabled: false }, { system: 'test' }),
  );

describe('review finding 5: a switched-off competition stops kickoff moves and automatic results', () => {
  it(
    'S4/F4: both sources move the kickoff but a disabled policy only proposes the change',
    async () => {
      await createdEvent();
      await switchOff();
      h.advance(MINUTE);
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, time: '17:00' }]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-02T17:00:00Z' }]));
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteFixtures(h.ctx);
      expect(summary.kickoffMoved).toBe(0);
      expect((await event()).start_time.toISOString()).toBe(KICKOFF.toISOString());
      expect(await openKinds()).toContain('kickoff_change');
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.fixture.kickoff_moved'`,
        ),
      ).toBe(0);

      // Switched on again, the same observations move the kickoff (nothing else changed).
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { enabled: true }, { system: 'test' }),
      );
      expect((await promoteFixtures(h.ctx)).kickoffMoved).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'S4/R5: agreeing sources do not auto-apply a result while the policy is off',
    async () => {
      await createdEvent({ autoResults: true });
      await switchOff();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 0], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([2, 0], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteResults(h.ctx);
      expect(summary.applied).toBe(0);
      expect(await event()).toMatchObject({ status: 'scheduled', score_home: null });
      expect(await openKinds()).toContain('result_ready');
    },
    TEST_TIMEOUT,
  );

  it(
    'R5: an extra-time competition is never applied automatically either',
    async () => {
      await createdEvent({ autoResults: true });
      await h.ctx.db.transaction((tx) =>
        setCompetitionPolicy(tx, h.premier, { extraTime: true }, { system: 'test' }),
      );
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 0], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([2, 0], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).applied).toBe(0);
      expect(await event()).toMatchObject({ status: 'scheduled', score_home: null });
      expect(await openKinds()).toContain('result_ready');
    },
    TEST_TIMEOUT,
  );
});

describe('review finding 3: a rejected staff confirmation is never replayed', () => {
  it(
    'R5: item A is rejected, the source flips back, the reopened item is dismissed: A stays unapplied',
    async () => {
      await createdEvent({ autoResults: false });
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([3, 1], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([3, 1], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      await promoteResults(h.ctx);
      const [a] = await rows<{ id: string }>(
        `SELECT id FROM scrape_review_items WHERE kind = 'result_ready' AND status = 'open'`,
      );
      const actor = { adminId: randomUUID() };
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, a!.id, {
          status: 'resolved',
          resolution: JSON.stringify({ decision: 'apply_result' }),
          actor,
          now: h.now(),
        }),
      );

      // A source corrects to 3-2 before the confirmation runs: rejected, a new item is opened.
      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([finishedJson([3, 2], [1, 0])]));
      await h.run('src-b');
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 1 });

      // The source flips back; the gate re-raises result_ready and replaces the reopened item's payload.
      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([finishedJson([3, 1], [1, 0])]));
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      await promoteResults(h.ctx);
      const open = await rows<{ id: string; payload: Record<string, unknown> }>(
        `SELECT id, payload FROM scrape_review_items WHERE kind = 'result_ready' AND status = 'open'`,
      );
      expect(open).toHaveLength(1);
      expect(open[0]!.payload.reopenedFor).toBeUndefined();

      // A person dismisses the fresh item ("do not apply"): nothing may settle the event.
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, open[0]!.id, {
          status: 'dismissed',
          resolution: JSON.stringify({ decision: 'dismiss' }),
          actor,
          now: h.now(),
        }),
      );
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 0, rejected: 0 });
      expect(await event()).toMatchObject({ status: 'scheduled', score_home: null });
    },
    TEST_TIMEOUT,
  );
});

describe('review finding 1: several clusters of one event never flip its kickoff', () => {
  const URL_C = 'https://api.example.com/c';
  const URL_D = 'https://api.example.com/d';
  const MOVED = '2026-11-04T15:00:00Z';

  async function withExtraSources(): Promise<void> {
    await createdEvent();
    await h.ctx.db.transaction(async (tx) => {
      for (const [id, url] of [
        ['src-c', URL_C],
        ['src-d', URL_D],
      ] as const) {
        await upsertSource(
          tx,
          {
            id,
            name: id,
            adapter: 'generic-json',
            upstream: `${id}-upstream`,
            config: {
              allowedHosts: ['api.example.com'],
              requests: [{ url, purpose: 'both' }],
              sport: 'football',
              recordsPath: 'data.events[*]',
              fields: {
                home: 'h',
                away: 'a',
                competition: { path: 'league' },
                kickoff: { path: 'kick', format: 'iso' },
                externalRef: 'id',
                status: { path: 'st', map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' } },
              },
            },
          },
          { system: 'test' },
        );
        await setSourceEnabled(tx, id, true, { system: 'test' });
        h.serve(url, jsonDoc([ARSENAL_CHELSEA_JSON]));
      }
    });
    for (const id of ['src-c', 'src-d']) await h.run(id);
  }

  it(
    'F4: two sources move the match, two still say the old date: no move, one kickoff_change',
    async () => {
      await withExtraSources();
      // b and c (independent upstreams) move the match two days later; a and d still say the old date.
      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: MOVED }]));
      h.serve(URL_C, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: MOVED }]));
      for (const id of ['src-a', 'src-b', 'src-c', 'src-d']) await h.run(id);
      for (let pass = 0; pass < 3; pass++) {
        h.advance(MINUTE);
        expect((await promoteFixtures(h.ctx)).kickoffMoved).toBe(0);
        expect((await event()).start_time.toISOString()).toBe(KICKOFF.toISOString());
      }
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.fixture.kickoff_moved'`,
        ),
      ).toBe(0);
      const items = await rows<{ kind: string; payload: { reasons: string[] } }>(
        `SELECT kind, payload FROM scrape_review_items WHERE status = 'open' AND kind = 'kickoff_change'`,
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.payload.reasons).toEqual(['sources_disagree']);
    },
    TEST_TIMEOUT,
  );

  it(
    'F3: an unknown fixture seen as two clusters is not created twice',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: MOVED }]));
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteFixtures(h.ctx);
      expect(summary.created).toBe(0);
      expect(
        await h.count(`SELECT count(*) AS n FROM events WHERE feed_provider = 'scraped'`),
      ).toBe(0);
      expect(await openKinds()).toContain('fixture_conflict');
    },
    TEST_TIMEOUT,
  );

  it(
    'F4: a move is re-checked under the event lock (the start is no longer the one decided on)',
    async () => {
      await createdEvent();
      const [scraped] = await listScrapedEvents(h.ctx.db, {
        from: new Date(KICKOFF.getTime() - 30 * DAY),
        to: new Date(KICKOFF.getTime() + 30 * DAY),
        includeFinished: true,
      });
      const decision = {
        action: 'update-kickoff' as const,
        eventId: scraped!.eventId,
        feedRef: scraped!.feedRef,
        from: new Date(KICKOFF.getTime() + HOUR),
        to: new Date(KICKOFF.getTime() + 3 * HOUR),
        rule: 'F4a' as const,
        upstreams: ['a', 'b'],
      };
      const done = await applyKickoff(h.ctx, decision, scraped!, h.now());
      expect(done.moved).toBe(false);
      expect((await event()).start_time.toISOString()).toBe(KICKOFF.toISOString());
      const ok = await applyKickoff(h.ctx, { ...decision, from: KICKOFF }, scraped!, h.now());
      expect(ok.moved).toBe(true);
      expect((await event()).start_time.getTime()).toBe(KICKOFF.getTime() + 3 * HOUR);
    },
    TEST_TIMEOUT,
  );
});

describe('review finding 2: a create decision never touches an existing feed_ref', () => {
  it(
    'F2/F3: a trader reschedules an event 60 days out, a stale source lists the old date: nothing moves, a conflict opens',
    async () => {
      await createdEvent();
      await h.pool.query(
        `UPDATE events SET start_time = start_time + interval '60 days' WHERE feed_provider = 'scraped'`,
      );
      const before = await event();
      const [market] = await rows<{ odds: string }>(
        `SELECT string_agg(s.odds_milli::text, ',' ORDER BY s.id) AS odds FROM selections s JOIN markets m ON m.id = s.market_id JOIN events e ON e.id = m.event_id WHERE e.feed_provider = 'scraped'`,
      );
      // Ratings changed since the event was priced: an upsert would re-price the open selections.
      await h.pool.query(
        `UPDATE teams SET ratings = jsonb_set(ratings, '{attack}', '2.5') WHERE id = $1`,
        [h.team('Arsenal')],
      );
      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([]));
      await h.run('src-a');
      await h.run('src-b');
      const summary = await promoteFixtures(h.ctx);
      expect(summary.created).toBe(0);
      expect(summary.held).toBe(1);
      expect(
        await h.count(`SELECT count(*) AS n FROM events WHERE feed_provider = 'scraped'`),
      ).toBe(1);
      expect((await event()).start_time.getTime()).toBe(before.start_time.getTime());
      const [after] = await rows<{ odds: string }>(
        `SELECT string_agg(s.odds_milli::text, ',' ORDER BY s.id) AS odds FROM selections s JOIN markets m ON m.id = s.market_id JOIN events e ON e.id = m.event_id WHERE e.feed_provider = 'scraped'`,
      );
      expect(after!.odds).toBe(market!.odds);
      const items = await rows<{ payload: { reasons: string[] } }>(
        `SELECT payload FROM scrape_review_items WHERE kind = 'fixture_conflict' AND status = 'open'`,
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.payload.reasons).toEqual(['feed_ref_exists']);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.fixture.created'`,
        ),
      ).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

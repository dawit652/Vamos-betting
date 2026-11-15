import { parseReviewPayload, REVIEW_PAYLOAD_SCHEMAS, type FeedReviewKind } from '@vamos/contracts';
import { setSourceEnabled, upsertSource } from '@vamos/db';
import { buildReviews } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { promoteResults } from '../src/pipeline/promote-results';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
  FAR_JSON,
  FAR_OF,
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
 * The back office shows a review item only if its payload satisfies the contract
 * (packages/contracts/src/feed.ts): otherwise the page says the item "could not be read" and offers
 * no action, so a person could not apply a result. These tests use items written by the real gates
 * and pipeline, never hand-written payloads (that is how the mismatch stayed hidden).
 */

let h: Harness;
afterEach(async () => {
  const done = h as Harness | undefined;
  // A test that builds no harness must not close the previous one a second time.
  h = undefined as unknown as Harness;
  await done?.close();
}, SETUP_TIMEOUT);

/** Both sources list the fixture and the event is created; sources and the clock are set by the caller. */
async function createdEvent(options: { autoResults?: boolean } = {}) {
  h = await createHarness({ autoResults: options.autoResults ?? false });
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
}

async function openItem(kind: FeedReviewKind) {
  const { rows } = await h.pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM scrape_review_items WHERE status = 'open' AND kind = $1`,
    [kind],
  );
  expect(rows, `an open ${kind} item`).toHaveLength(1);
  return rows[0]!.payload;
}

/** Shared by every result item: the match, as the back office prints it. */
const MATCH = { home: 'Arsenal', away: 'Chelsea', kickoff: KICKOFF.toISOString() };

describe('result items satisfy the back-office contract', () => {
  it(
    'result_ready: two upstreams agree and a person confirms',
    async () => {
      await createdEvent({ autoResults: false });
      h.at(new Date(KICKOFF.getTime() + 3 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([2, 1], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(20 * MINUTE);
      await promoteResults(h.ctx);

      const payload = parseReviewPayload('result_ready', await openItem('result_ready'));
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({
        ...MATCH,
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
        exposure: { openBets: 0, totalStake: '0' },
      });
      expect(payload!.gameId).toMatch(/^\d+$/);
      expect(payload!.sources.map((s) => [s.sourceId, s.upstream]).sort()).toEqual([
        ['src-a', 'openfootball'],
        ['src-b', 'example-api'],
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'result_unverified: one source, after the waiting time',
    async () => {
      await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 8 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      await h.run('src-a');
      await promoteResults(h.ctx);

      const payload = parseReviewPayload('result_unverified', await openItem('result_unverified'));
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({
        ...MATCH,
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
      });
      expect(payload!.sources.map((s) => s.sourceId)).toEqual(['src-a']);
    },
    TEST_TIMEOUT,
  );

  it(
    'result_conflict: two sources give different scores',
    async () => {
      await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 3 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([1, 1], [0, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      await promoteResults(h.ctx);

      const payload = parseReviewPayload('result_conflict', await openItem('result_conflict'));
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({ ...MATCH, appliedScore: null });
      expect(
        payload!.observations.map((o) => [o.sourceId, o.score?.home, o.score?.away]).sort(),
      ).toEqual([
        ['src-a', 2, 1],
        ['src-b', 1, 1],
      ]);
    },
    TEST_TIMEOUT,
  );

  it(
    'result_correction: a source changes the score of a result that was applied',
    async () => {
      await createdEvent({ autoResults: true });
      h.at(new Date(KICKOFF.getTime() + 3 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([2, 1], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(20 * MINUTE);
      expect((await promoteResults(h.ctx)).applied).toBe(1);

      h.advance(HOUR);
      h.serve(URL_A, ofDoc([finishedOf([3, 1], [1, 0])]));
      await h.run('src-a');
      await promoteResults(h.ctx);

      const payload = parseReviewPayload('result_correction', await openItem('result_correction'));
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({
        ...MATCH,
        appliedScore: { home: 2, away: 1, htHome: 1, htAway: 0 },
      });
      expect(payload!.observations.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'cancellation_proposed: a source says the match is postponed (a plain detail sentence)',
    async () => {
      await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 3 * HOUR));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, st: 'PST' }]));
      await h.run('src-b');
      await promoteResults(h.ctx);

      const payload = parseReviewPayload(
        'cancellation_proposed',
        await openItem('cancellation_proposed'),
      );
      expect(payload).not.toBeNull();
      expect(payload!.detail).toContain('src-b:postponed');
    },
    TEST_TIMEOUT,
  );
});

describe('the other kinds satisfy the contract too', () => {
  const kindOf = async (kind: FeedReviewKind) => {
    const stored = await openItem(kind);
    const parsed = parseReviewPayload(kind, stored);
    if (parsed === null) {
      const issues = REVIEW_PAYLOAD_SCHEMAS[kind].safeParse(stored).error?.issues ?? [];
      throw new Error(
        `${kind} does not satisfy the contract: ${JSON.stringify(issues.map((i) => [i.path.join('.'), i.message]))}`,
      );
    }
    return parsed as { detail?: string } & Record<string, unknown>;
  };

  it(
    'unknown_team: a name no alias or catalogue entry matches',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([{ ...ARSENAL_CHELSEA_OF, team1: 'Nowhere Rovers FC' }]));
      await h.run('src-a');
      await promoteFixtures(h.ctx);
      const payload = await kindOf('unknown_team');
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({ raw: 'Nowhere Rovers FC', sourceId: 'src-a' });
    },
    TEST_TIMEOUT,
  );

  it(
    'unknown_competition: a competition label no alias matches',
    async () => {
      h = await createHarness();
      const actor = { system: 'test' };
      await h.ctx.db.transaction(async (tx) => {
        await upsertSource(
          tx,
          {
            id: 'src-c',
            name: 'unknown league',
            adapter: 'openfootball',
            upstream: 'openfootball-c',
            config: {
              allowedHosts: ['raw.githubusercontent.com'],
              requests: [{ url: URL_A, competition: 'Atlantis League' }],
              timeZone: 'Europe/London',
              sport: 'football',
            },
          },
          actor,
        );
        await setSourceEnabled(tx, 'src-c', true, actor);
      });
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      await h.run('src-c');
      await promoteFixtures(h.ctx);
      const payload = await kindOf('unknown_competition');
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({ raw: 'Atlantis League', sourceId: 'src-c' });
    },
    TEST_TIMEOUT,
  );

  it(
    'fixture_conflict: sources put a new fixture on different days',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, kick: '2026-11-05T15:00:00Z' }]));
      await h.run('src-a');
      await h.run('src-b');
      await promoteFixtures(h.ctx);
      const payload = await kindOf('fixture_conflict');
      expect(payload).not.toBeNull();
      expect(payload.detail).toContain('Sources disagree about a fixture');
    },
    TEST_TIMEOUT,
  );

  it(
    'fixture_missing: an event no source lists any more after 48 hours',
    async () => {
      await createdEvent();
      h.serve(URL_A, ofDoc([FAR_OF]));
      h.serve(URL_B, jsonDoc([FAR_JSON]));
      h.advance(49 * HOUR);
      await h.run('src-a');
      await h.run('src-b');
      await promoteFixtures(h.ctx);
      const payload = await kindOf('fixture_missing');
      expect(payload).not.toBeNull();
      expect(payload.detail).toContain('No source lists this fixture any more');
    },
    TEST_TIMEOUT,
  );

  it(
    'source_broken: a page that stopped parsing',
    async () => {
      await createdEvent();
      for (let i = 0; i < 3; i += 1) {
        h.advance(20 * MINUTE);
        await h.run('src-a');
      }
      h.advance(20 * MINUTE);
      h.serve(URL_A, 'this is not json at all');
      expect((await h.run('src-a')).status).toBe('broken');
      const payload = await kindOf('source_broken');
      expect(payload).not.toBeNull();
      expect(payload).toMatchObject({ sourceId: 'src-a' });
    },
    TEST_TIMEOUT,
  );
});

describe('items the contract reads as a plain detail', () => {
  it('buildReviews writes a sentence with the reason and what the gate saw', () => {
    const [review] = buildReviews(
      'fx|subject',
      [
        {
          kind: 'score_basis_unknown',
          rule: 'R10',
          reason: 'no_regular_time_score',
          detail: ['src-a:includes_extra_time'],
        },
      ],
      () => ({}),
    );
    expect(review!.payload.detail).toBe(
      'A score is not known to be a regular-time score: no_regular_time_score ["src-a:includes_extra_time"]',
    );
    expect(parseReviewPayload('score_basis_unknown', review!.payload)).not.toBeNull();
  });
});

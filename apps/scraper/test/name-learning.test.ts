import { addTeamAlias } from '@vamos/db';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { reresolveUnresolved } from '../src/pipeline/run-source';
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
 * Rule L1 (docs/plans/name-learning.md): a name a person mapped for one source is known from every
 * other source too, where the team already plays (its competition, or one of its country), so the
 * same spelling is never asked again.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
  h = undefined as unknown as Harness;
}, SETUP_TIMEOUT);

const ACTOR = { system: 'test' };

const unknownItems = async (): Promise<string[]> =>
  (
    await h.pool.query<{ subject_key: string }>(
      `SELECT subject_key FROM scrape_review_items
        WHERE kind = 'unknown_team' AND status = 'open' ORDER BY subject_key`,
    )
  ).rows.map((row) => row.subject_key);

const homeTeamOf = async (sourceId: string): Promise<string | null> =>
  (
    await h.pool.query<{ home_team_id: string | null }>(
      `SELECT home_team_id FROM scrape_observations WHERE source_id = $1 AND kind = 'fixture'
        ORDER BY id DESC LIMIT 1`,
      [sourceId],
    )
  ).rows[0]?.home_team_id ?? null;

describe('L1: a mapped name is known from every source', () => {
  it(
    'src-b spells Arsenal as src-a was taught to: it resolves without a new item',
    async () => {
      h = await createHarness();
      // Arsenal plays in the Premier League: src-a's fixture creates the event.
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      await h.run('src-a');
      expect((await promoteFixtures(h.ctx)).created).toBe(1);
      // A person mapped "The Gunners" for src-a only (the back office's default scope).
      await h.ctx.db.transaction((tx) =>
        addTeamAlias(
          tx,
          {
            sportId: 'football',
            aliasNorm: 'the gunners',
            sourceId: 'src-a',
            teamId: h.team('Arsenal'),
          },
          ACTOR,
        ),
      );

      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, h: 'The Gunners' }]));
      await h.run('src-b');
      expect(await homeTeamOf('src-b')).toBe(h.team('Arsenal'));
      expect(await unknownItems()).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  it(
    'a row read before the mapping resolves on the next pass, and its item closes',
    async () => {
      h = await createHarness();
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      await h.run('src-a');
      expect((await promoteFixtures(h.ctx)).created).toBe(1);
      h.advance(MINUTE);
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, h: 'The Gunners' }]));
      await h.run('src-b');
      expect(await homeTeamOf('src-b')).toBeNull();
      expect(await unknownItems()).toEqual(['football|the gunners']);

      await h.ctx.db.transaction((tx) =>
        addTeamAlias(
          tx,
          {
            sportId: 'football',
            aliasNorm: 'the gunners',
            sourceId: 'src-a',
            teamId: h.team('Arsenal'),
          },
          ACTOR,
        ),
      );
      expect(await reresolveUnresolved(h.ctx)).toBeGreaterThan(0);
      expect(await homeTeamOf('src-b')).toBe(h.team('Arsenal'));
      expect(await unknownItems()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

import { randomUUID } from 'node:crypto';
import { recordRaw, resolveReviewItem } from '@vamos/db';
import { sha256Hex } from '@vamos/scraper';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { applyStaffConfirmations, promoteResults } from '../src/pipeline/promote-results';
import { pruneRaw } from '../src/tasks/prune';
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
 * The pages behind an open result dispute are evidence for the person who decides:
 * they are kept like the pages behind an applied result, and the rest is pruned.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

const sha = (body: string) => sha256Hex(new TextEncoder().encode(body));
const rawRows = async (hash: string) =>
  h.count(`SELECT count(*) AS n FROM scrape_raw WHERE content_hash = $1`, [hash]);
const keptRows = async (hash: string) =>
  h.count(`SELECT count(*) AS n FROM scrape_raw WHERE content_hash = $1 AND keep`, [hash]);
const openKinds = async () =>
  (
    await h.pool.query<{ kind: string }>(
      `SELECT kind FROM scrape_review_items WHERE status = 'open' AND kind LIKE 'result_%'`,
    )
  ).rows.map((r) => r.kind);

/** Both sources list the fixture before kickoff; the event is created. */
async function createdEvent(): Promise<{ earlyA: string; earlyB: string }> {
  h = await createHarness({ autoResults: true });
  const earlyA = ofDoc([ARSENAL_CHELSEA_OF]);
  const earlyB = jsonDoc([ARSENAL_CHELSEA_JSON]);
  h.serve(URL_A, earlyA);
  h.serve(URL_B, earlyB);
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  return { earlyA, earlyB };
}

/** Old snapshot that no observation stands on, with its archive file. */
async function unrelatedOldSnapshot(): Promise<string> {
  const body = '{"unrelated":"page"}';
  const fetchedAt = new Date(h.now().getTime() - 3 * HOUR);
  await h.ctx.archive.put(new TextEncoder().encode(body), { fetchedAt });
  const { rows } = await h.pool.query<{ id: string }>(`SELECT id FROM scrape_runs LIMIT 1`);
  await recordRaw(h.ctx.db, {
    runId: rows[0]!.id,
    url: 'https://api.example.com/unrelated',
    status: 200,
    contentType: 'application/json',
    contentHash: sha(body),
    bytes: body.length,
    fetchedAt,
  });
  return sha(body);
}

async function expectPrunedExceptEvidence(
  evidence: readonly string[],
  pruned: readonly string[],
): Promise<void> {
  for (const hash of evidence) expect(await keptRows(hash)).toBeGreaterThan(0);
  for (const hash of pruned) expect(await rawRows(hash)).toBe(1);
  h.advance(60 * 24 * HOUR);
  expect(await pruneRaw(h.ctx)).toBeGreaterThan(0);
  for (const hash of evidence) {
    expect(await rawRows(hash)).toBeGreaterThan(0);
    expect(await h.ctx.archive.has(hash)).toBe(true);
  }
  for (const hash of pruned) {
    expect(await rawRows(hash)).toBe(0);
    expect(await h.ctx.archive.has(hash)).toBe(false);
  }
}

describe('evidence behind a result dispute is kept', () => {
  it(
    'R3: two sources with different scores: the pages behind the result_conflict survive pruning',
    async () => {
      const early = await createdEvent();
      const unrelated = await unrelatedOldSnapshot();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      const pageA = ofDoc([finishedOf([2, 0], [1, 0])]);
      const pageB = jsonDoc([finishedJson([1, 0], [0, 0])]);
      h.serve(URL_A, pageA);
      h.serve(URL_B, pageB);
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).held).toBe(1);
      expect(await openKinds()).toContain('result_conflict');

      await expectPrunedExceptEvidence(
        [sha(pageA), sha(pageB)],
        [sha(early.earlyA), sha(early.earlyB), unrelated],
      );

      // The item is refreshed with a newer page of one source: that page is kept too.
      h.at(new Date(KICKOFF.getTime() + 3 * HOUR));
      const newerB = jsonDoc([finishedJson([1, 1], [0, 0])]);
      h.serve(URL_B, newerB);
      await h.run('src-b');
      await promoteResults(h.ctx);
      expect(await keptRows(sha(newerB))).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    'R6: a score from one source only (result_unverified): its page survives pruning',
    async () => {
      const early = await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 9 * HOUR));
      const pageB = jsonDoc([finishedJson([2, 1], [1, 0])]);
      h.serve(URL_B, pageB);
      await h.run('src-b');
      await promoteResults(h.ctx);
      expect(await openKinds()).toContain('result_unverified');
      await expectPrunedExceptEvidence([sha(pageB)], [sha(early.earlyA)]);
    },
    TEST_TIMEOUT,
  );

  it(
    'R8: a source contradicts an applied result (result_correction): the contradicting page survives pruning',
    async () => {
      await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([1, 0])]));
      h.serve(URL_B, jsonDoc([finishedJson([1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      expect((await promoteResults(h.ctx)).applied).toBe(1);

      h.advance(HOUR);
      const correction = jsonDoc([finishedJson([2, 0])]);
      h.serve(URL_B, correction);
      await h.run('src-b');
      await promoteResults(h.ctx);
      expect(await openKinds()).toContain('result_correction');
      await expectPrunedExceptEvidence([sha(correction)], []);
    },
    TEST_TIMEOUT,
  );

  it(
    'a result_ready item (nothing disputed) does not keep pages by itself',
    async () => {
      h = await createHarness({ autoResults: false });
      h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
      h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
      await h.run('src-a');
      await h.run('src-b');
      await promoteFixtures(h.ctx);
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      const pageA = ofDoc([finishedOf([3, 1], [1, 0])]);
      h.serve(URL_A, pageA);
      h.serve(URL_B, jsonDoc([finishedJson([3, 1], [1, 0])]));
      await h.run('src-a');
      await h.run('src-b');
      h.advance(16 * MINUTE);
      await h.run('src-a');
      await h.run('src-b');
      await promoteResults(h.ctx);
      expect(await openKinds()).toEqual(['result_ready']);
      expect(await h.count(`SELECT count(*) AS n FROM scrape_raw WHERE keep`)).toBe(0);

      // Applied through staff: now the evidence is kept (the existing path).
      const [item] = (
        await h.pool.query<{ id: string }>(
          `SELECT id FROM scrape_review_items WHERE kind = 'result_ready' AND status = 'open'`,
        )
      ).rows;
      await h.ctx.db.transaction((tx) =>
        resolveReviewItem(tx, item!.id, {
          status: 'resolved',
          resolution: JSON.stringify({ decision: 'apply_result' }),
          actor: { adminId: randomUUID() },
          now: h.now(),
        }),
      );
      expect(await applyStaffConfirmations(h.ctx)).toEqual({ applied: 1, rejected: 0 });
      expect(await keptRows(sha(pageA))).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});

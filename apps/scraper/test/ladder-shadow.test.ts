import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertSourceTrust } from '@vamos/db';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promoteFixtures } from '../src/pipeline/promote-fixtures';
import { promoteResults } from '../src/pipeline/promote-results';
import { cliHarness } from './cli-helpers';
import {
  ARSENAL_CHELSEA_JSON,
  ARSENAL_CHELSEA_OF,
  createHarness,
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
 * The result ladder in shadow (plan task 1.6): after the gate has decided for an event and has NOT
 * applied it, the ladder's rung B to D decision is recorded. It only records: nothing is resulted,
 * and the review items are what the gate alone would have left.
 */

let h: Harness;
afterEach(async () => {
  const done = h;
  // Tests that need no harness must not close the previous one again.
  h = undefined as unknown as Harness;
  await done?.close();
}, SETUP_TIMEOUT);

interface ShadowRow {
  decision_key: string;
  rung: string;
  action: string;
  reason: string | null;
  score: unknown;
  strict: boolean | null;
  upstreams: string[];
  dissent: string[];
  first_decided_at: Date;
  last_decided_at: Date;
}
const shadowRows = async (): Promise<ShadowRow[]> =>
  (
    await h.pool.query<ShadowRow>(
      `SELECT decision_key, rung, action, reason, score, strict, upstreams, dissent,
              first_decided_at, last_decided_at
         FROM scrape_ladder_shadow ORDER BY decision_key`,
    )
  ).rows;

/** What the review queue holds, without ids and clocks of the rows. */
const reviewItems = async (): Promise<unknown[]> =>
  (
    await h.pool.query(
      `SELECT kind, subject_key, status, severity, title, payload FROM scrape_review_items
        ORDER BY kind, subject_key, status`,
    )
  ).rows;
const unresulted = async (): Promise<number> =>
  h.count(`SELECT count(*) AS n FROM events WHERE status = 'scheduled' AND resulted_at IS NULL`);
const resultAudits = async (): Promise<number> =>
  h.count(`SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.result.applied'`);

const trustUpstream = (upstream: string, compared = 1000, agreed = 999) =>
  upsertSourceTrust(h.ctx.db, {
    upstream,
    sport: 'football',
    compared,
    agreed,
    windowFrom: null,
    windowTo: null,
    disagreements: [],
    measuredAt: h.now(),
  });

/** Both sources list the fixture before kickoff and the event is created; returns its id. */
async function createdEvent(): Promise<string> {
  h = await createHarness();
  h.serve(URL_A, ofDoc([ARSENAL_CHELSEA_OF]));
  h.serve(URL_B, jsonDoc([ARSENAL_CHELSEA_JSON]));
  await h.run('src-a');
  await h.run('src-b');
  expect((await promoteFixtures(h.ctx)).created).toBe(1);
  const { rows } = await h.pool.query<{ id: string }>(`SELECT id FROM events`);
  return rows[0]!.id;
}

const cli = () => cliHarness({ db: h.ctx.db });
interface ShadowJson {
  decisions: {
    eventId: string;
    rung: string;
    action: string;
    reason: string | null;
    outcome: string;
  }[];
  summary: {
    label: string;
    decisions: number;
    agreed: number;
    disagreed: number;
    pending: number;
  }[];
}
const shadowReport = async (...args: string[]): Promise<ShadowJson> => {
  const run = await cli().run('review', 'ladder-shadow', '--json', ...args);
  expect(run.code, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as ShadowJson;
};

describe('ladder shadow in the result pass', () => {
  it(
    'records rung C for a lone trusted source and changes nothing else',
    async () => {
      const eventId = await createdEvent();
      // One source has the final score two hours after kickoff; the other has nothing yet.
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      await h.run('src-a');

      // More than six hours after the match could have ended, the score has stood for seven hours.
      h.at(new Date(KICKOFF.getTime() + 9 * HOUR));
      // Without measured trust the ladder does nothing yet: the baseline of the gate alone.
      expect(await promoteResults(h.ctx)).toMatchObject({ applied: 0, held: 1, failed: 0 });
      expect(await shadowRows()).toEqual([]);
      const baseline = await reviewItems();
      expect(baseline.length).toBeGreaterThan(0);

      await trustUpstream('openfootball');
      expect(await promoteResults(h.ctx)).toMatchObject({ applied: 0, held: 1, failed: 0 });

      const [row, ...rest] = await shadowRows();
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        decision_key: 'apply:C::2-1/1-0',
        rung: 'C',
        action: 'apply',
        reason: null,
        score: { home: 2, away: 1, htHome: 1, htAway: 0 },
        strict: null,
        upstreams: ['openfootball'],
        dissent: [],
      });
      // Nothing applied: the event is as it was, no audit of a result, the review items the same.
      expect(await unresulted()).toBe(1);
      expect(await resultAudits()).toBe(0);
      expect(await reviewItems()).toEqual(baseline);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM events WHERE id = '${eventId}' AND score_home IS NULL`,
        ),
      ).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'writes the same decision once within an hour and a changed decision as a new row',
    async () => {
      await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      await h.run('src-a');
      await trustUpstream('openfootball');

      h.at(new Date(KICKOFF.getTime() + 9 * HOUR));
      await promoteResults(h.ctx);
      const first = (await shadowRows())[0]!;
      // A pass every minute does not rewrite the row.
      for (let i = 0; i < 5; i += 1) {
        h.advance(MINUTE);
        await promoteResults(h.ctx);
      }
      expect(await shadowRows()).toEqual([first]);
      // An hour later it is seen again: still one row, decided later.
      h.advance(HOUR);
      await promoteResults(h.ctx);
      const later = await shadowRows();
      expect(later).toHaveLength(1);
      expect(later[0]!.first_decided_at).toEqual(first.first_decided_at);
      expect(later[0]!.last_decided_at.getTime()).toBeGreaterThan(first.last_decided_at.getTime());

      // The source changes its mind: a new decision is a new row; the old one stays as evidence.
      h.serve(URL_A, ofDoc([finishedOf([2, 2], [1, 0])]));
      await h.run('src-a');
      h.advance(7 * HOUR);
      await promoteResults(h.ctx);
      expect((await shadowRows()).map((r) => r.decision_key)).toEqual([
        'apply:C::2-1/1-0',
        'apply:C::2-2/1-0',
      ]);
      expect(await unresulted()).toBe(1);
    },
    TEST_TIMEOUT,
  );

  it(
    'records the 48-hour rule as a void and the review shows what happened next',
    async () => {
      const eventId = await createdEvent();
      // Only the JSON source says anything: the match is postponed.
      h.at(new Date(KICKOFF.getTime() + 3 * HOUR));
      h.serve(URL_B, jsonDoc([{ ...ARSENAL_CHELSEA_JSON, st: 'PST' }]));
      await h.run('src-b');

      h.at(new Date(KICKOFF.getTime() + 49 * HOUR));
      await promoteResults(h.ctx);
      const [row, ...rest] = await shadowRows();
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        decision_key: 'void:D:not_played:',
        rung: 'D',
        action: 'void',
        reason: 'not_played',
        strict: true,
        score: null,
        upstreams: ['example-api'],
      });
      // The scraper rule: nothing is cancelled or voided from scraped data.
      expect(await unresulted()).toBe(1);
      expect(
        await h.count(
          `SELECT count(*) AS n FROM events WHERE id = '${eventId}' AND status = 'scheduled'`,
        ),
      ).toBe(1);

      // Not settled yet: the decision is pending.
      expect(await shadowReport('--since', '2026-11-01')).toMatchObject({
        decisions: [{ rung: 'D', outcome: 'pending' }],
        summary: [
          {
            label: 'D void not_played (strict)',
            decisions: 1,
            agreed: 0,
            disagreed: 0,
            pending: 1,
          },
        ],
      });

      // A person voids the event: the shadow would have been right.
      await h.pool.query(
        `UPDATE events SET status = 'cancelled', resulted_at = now() WHERE id = $1`,
        [eventId],
      );
      expect((await shadowReport('--since', '2026-11-01')).summary).toEqual([
        { label: 'D void not_played (strict)', decisions: 1, agreed: 1, disagreed: 0, pending: 0 },
      ]);

      // The match was played after all: wrong.
      await h.pool.query(
        `UPDATE events SET status = 'finished', score_home = 1, score_away = 0 WHERE id = $1`,
        [eventId],
      );
      const played = await shadowReport('--since', '2026-11-01');
      expect(played.decisions[0]).toMatchObject({ outcome: 'played' });
      expect(played.summary[0]).toMatchObject({ agreed: 0, disagreed: 1, pending: 0 });
    },
    TEST_TIMEOUT,
  );

  it(
    'a failing shadow only logs an alarm and the pass goes on as before',
    async () => {
      await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      await h.run('src-a');
      h.at(new Date(KICKOFF.getTime() + 9 * HOUR));
      expect(await promoteResults(h.ctx)).toMatchObject({ held: 1, failed: 0 });
      const baseline = await reviewItems();

      // The trust table is gone: reading it fails.
      await h.pool.query(`ALTER TABLE scrape_source_trust RENAME TO scrape_source_trust_gone`);
      const logger = { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() };
      const ctx = { ...h.ctx, logger: logger as unknown as Logger };
      expect(await promoteResults(ctx)).toMatchObject({ applied: 0, held: 1, failed: 0 });
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ alarm: 'ladder_shadow_failed' }),
        expect.any(String),
      );
      expect(await reviewItems()).toEqual(baseline);
      expect(await unresulted()).toBe(1);
      expect(await shadowRows()).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});

describe('review ladder-shadow', () => {
  it(
    'lists decisions against the applied score and summarises per rung and reason',
    async () => {
      const eventId = await createdEvent();
      h.at(new Date(KICKOFF.getTime() + 2 * HOUR));
      h.serve(URL_A, ofDoc([finishedOf([2, 1], [1, 0])]));
      await h.run('src-a');
      await trustUpstream('openfootball');
      h.at(new Date(KICKOFF.getTime() + 9 * HOUR));
      await promoteResults(h.ctx);

      // Not resulted yet.
      let text = (await cli().run('review', 'ladder-shadow', '--since', '2026-11-01')).stdout;
      expect(text).toContain('Nothing here was applied or voided');
      expect(text).toMatch(
        /Arsenal v Chelsea\s+2026-11-02T15:00:00\.000Z\s+C apply\s+2-1 \(HT 1-0\)\s+openfootball/,
      );
      expect(text).toMatch(/pending\s*$/m);
      expect(text).toMatch(/^C apply\s+1\s+0\s+0\s+1$/m);

      // A person enters the same score (half time may differ in notation only when one side has none).
      await h.pool.query(
        `UPDATE events SET status = 'finished', resulted_at = now(), score_home = 2, score_away = 1,
                ht_score_home = 1, ht_score_away = 0 WHERE id = $1`,
        [eventId],
      );
      let json = await shadowReport('--since', '2026-11-01');
      expect(json.decisions).toEqual([expect.objectContaining({ eventId, outcome: 'match' })]);
      expect(json.summary).toEqual([
        { label: 'C apply', decisions: 1, agreed: 1, disagreed: 0, pending: 0 },
      ]);
      text = (await cli().run('review', 'ladder-shadow', '--since', '2026-11-01')).stdout;
      expect(text).toMatch(/^C apply\s+1\s+1\s+0\s+0$/m);

      // Another full-time score: a mismatch. No half time on the event: only full time is compared.
      await h.pool.query(
        `UPDATE events SET score_home = 3, ht_score_home = NULL, ht_score_away = NULL WHERE id = $1`,
        [eventId],
      );
      json = await shadowReport('--since', '2026-11-01');
      expect(json.decisions[0]).toMatchObject({ outcome: 'mismatch' });
      expect(json.summary[0]).toMatchObject({ agreed: 0, disagreed: 1 });
      await h.pool.query(`UPDATE events SET score_home = 2, score_away = 1 WHERE id = $1`, [
        eventId,
      ]);
      expect((await shadowReport('--since', '2026-11-01')).decisions[0]).toMatchObject({
        outcome: 'match',
      });

      // Decisions are filtered by the day they were first made.
      expect((await shadowReport('--since', '2026-11-04')).decisions).toEqual([]);
      const empty = await cli().run('review', 'ladder-shadow', '--since', '2026-11-04');
      expect(empty.stdout).toContain('no shadow decisions');
    },
    TEST_TIMEOUT,
  );

  it('refuses a bad date and extra arguments', async () => {
    const run = cliHarness();
    for (const args of [['--since', '2026-1-1'], ['--since', 'last week'], ['extra']]) {
      expect((await run.run('review', 'ladder-shadow', ...args)).code).toBe(2);
    }
  });
});

describe('the shadow module', () => {
  it('can only record: it takes no result, void, cancel or review operation', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/pipeline/ladder-shadow.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const word of [
      'resultEvent',
      'applyConfirmedResult',
      'openReviewItem',
      'closeReviewItemsBySubject',
      'lockEvent',
      'markRawKeep',
      'transaction',
      'update(',
      'delete(',
    ]) {
      expect(source, word).not.toContain(word);
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliHarness } from './cli-helpers';
import {
  createHarness,
  FAR_OF,
  jsonDoc,
  ofDoc,
  SETUP_TIMEOUT,
  TEST_TIMEOUT,
  URL_A,
  URL_B,
  type Harness,
} from './helpers';

let h: Harness;
let cli: ReturnType<typeof cliHarness>;
beforeAll(async () => {
  h = await createHarness();
  // openfootball: two matches with a club the catalogue lacks (spelled once each), and a known pair.
  h.serve(
    URL_A,
    ofDoc([
      { date: '2026-11-02', time: '15:00', team1: 'Kebele Rovers', team2: 'Arsenal FC' },
      { date: '2026-11-03', time: '15:00', team1: 'Chelsea FC', team2: 'Kebele Rovers' },
      FAR_OF,
    ]),
  );
  // The other source writes it differently ("KEBELE ROVERS" normalises the same), and one more newcomer.
  h.serve(
    URL_B,
    jsonDoc([
      { id: 1, kick: '2026-11-02T15:00:00Z', h: 'KEBELE ROVERS', a: 'Arsenal', st: 'NS' },
      { id: 2, kick: '2026-11-04T15:00:00Z', h: 'Chelsea', a: 'Nobody Town', st: 'NS' },
      { id: 3, kick: '2026-11-05T15:00:00Z', h: 'Zanzibar, Stars', a: 'Arsenal', st: 'NS' },
    ]),
  );
  await h.run('src-a');
  await h.run('src-b');
  cli = cliHarness({ db: h.ctx.db });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await h?.close();
}, SETUP_TIMEOUT);

describe('review gaps', () => {
  it(
    'prints CSV for add-club review: competition, spelling, sources, rows, first_seen',
    async () => {
      const run = await cli.run('review', 'gaps', '--csv');
      expect(run.code).toBe(0);
      const lines = run.stdout.split('\n');
      expect(lines[0]).toBe('competition,spelling,sources,rows,first_seen');
      expect(lines).toHaveLength(4);
      expect(lines[1]).toMatch(
        /^premier-league,Kebele Rovers,src-a;src-b,3,2026-10-29T12:00:00\.000Z$/,
      );
      expect(lines[2]).toMatch(/^premier-league,Nobody Town,src-b,1,2026-10-29T12:00:00\.000Z$/);
      // A cell with a comma is quoted.
      expect(lines[3]).toMatch(
        /^premier-league,"Zanzibar, Stars",src-b,1,2026-10-29T12:00:00\.000Z$/,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    'prints a table, and --json the same rows with the normalised spelling',
    async () => {
      const text = await cli.run('review', 'gaps');
      expect(text.code).toBe(0);
      expect(text.stdout.split('\n')[0]).toMatch(
        /^competition\s+spelling\s+sources\s+rows\s+first seen$/,
      );
      expect(text.stdout).toContain('3 spelling(s) missing from the catalogue');

      const json = JSON.parse((await cli.run('review', 'gaps', '--json')).stdout) as {
        gaps: Array<{ spelling: string; normalized: string; sources: string[]; rows: number }>;
      };
      expect(json.gaps.map((g) => [g.spelling, g.normalized, g.sources, g.rows])).toEqual([
        ['Kebele Rovers', 'kebele rovers', ['src-a', 'src-b'], 3],
        ['Nobody Town', 'nobody town', ['src-b'], 1],
        ['Zanzibar, Stars', 'zanzibar stars', ['src-b'], 1],
      ]);
    },
    TEST_TIMEOUT,
  );

  it('--competition keeps one competition, and a dismissed item takes its spelling out', async () => {
    expect((await cli.run('review', 'gaps', '--competition', 'la-liga', '--csv')).stdout).toBe(
      'competition,spelling,sources,rows,first_seen',
    );
    expect((await cli.run('review', 'gaps', '--competition', 'la-liga')).stdout).toBe(
      'no catalogue gaps',
    );
    await h.pool.query(
      `UPDATE scrape_review_items SET status = 'dismissed', resolved_at = now(), resolution = 'x'
       WHERE kind = 'unknown_team' AND subject_key = 'football|nobody town'`,
    );
    const after = await cli.run('review', 'gaps', '--csv');
    expect(after.stdout.split('\n')).toHaveLength(3);
    expect(after.stdout).not.toContain('Nobody Town');
  });

  it('refuses --csv with --json and stray arguments', async () => {
    expect((await cli.run('review', 'gaps', '--csv', '--json')).code).toBe(2);
    expect((await cli.run('review', 'gaps', 'extra')).code).toBe(2);
  });
});

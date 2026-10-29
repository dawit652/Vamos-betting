import { setTeamRatings } from '@vamos/db';
import { replayRatings } from '@vamos/feed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKFILL_KEY } from '../src/cli/ratings';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

const teamIds = new Map<string, string>();
const teamId = (shortName: string): string => teamIds.get(shortName)!;
let db: Awaited<ReturnType<typeof catalogDatabase>>;
let cli: ReturnType<typeof cliHarness>;
beforeAll(async () => {
  db = await catalogDatabase();
  cli = cliHarness({ db: db.db });
  const rows = await db.pool.query<{ id: string; short_name: string }>(
    'SELECT id, short_name FROM teams',
  );
  for (const row of rows.rows) teamIds.set(row.short_name, row.id);
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

// Deliberately out of date order: the command sorts them.
const RESULTS = [
  { date: '2025-09-20', home: 'Chelsea', away: 'Arsenal', homeGoals: 0, awayGoals: 0 },
  { date: '2025-08-16', home: 'Arsenal', away: 'Chelsea', homeGoals: 3, awayGoals: 1 },
  { date: '2025-09-27', home: 'Tottenham Hotspur', away: 'Arsenal', homeGoals: 1, awayGoals: 2 },
];
const FILE = 'results.json';
const BACKFILL = ['ratings', 'backfill', '--file', FILE, '--competition', 'premier-league'];

const ratingsOf = async (shortName: string) =>
  (
    await db.pool.query<{ ratings: Record<string, number> | null }>(
      `SELECT ratings FROM teams WHERE short_name = $1`,
      [shortName],
    )
  ).rows[0]!.ratings;
const audits = async () =>
  Number(
    (
      await db.pool.query(
        `SELECT count(*) AS n FROM audit_log WHERE action = 'scrape.ratings.updated'`,
      )
    ).rows[0].n,
  );

describe('ratings backfill', () => {
  it('--dry-run prints before and after and writes nothing', async () => {
    cli.files.set(FILE, JSON.stringify(RESULTS));
    const before = await ratingsOf('Arsenal');
    const result = await cli.run(...BACKFILL, '--dry-run');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('3 results for premier-league, 3 teams');
    expect(result.stdout).toContain('would update');
    expect(result.stdout).toContain('dry run: 3 would change, 0 unchanged; nothing was written');
    expect(result.stdout).toMatch(/Arsenal\s+attack 1\.500 defence 0\.680 matches 0\s+attack /);
    expect(await ratingsOf('Arsenal')).toEqual(before);
    expect(await audits()).toBe(0);
  });

  it('replays oldest first, stores the match count and the highest date, and audits', async () => {
    const result = await cli.run(...BACKFILL);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('3 updated, 0 unchanged');

    const expected = replayRatings([
      { home: 'A', away: 'C', homeGoals: 3, awayGoals: 1 },
      { home: 'C', away: 'A', homeGoals: 0, awayGoals: 0 },
      { home: 'T', away: 'A', homeGoals: 1, awayGoals: 2 },
    ]);
    const arsenal = (await ratingsOf('Arsenal'))!;
    expect(arsenal.matches).toBe(3);
    expect(arsenal[BACKFILL_KEY]).toBe(20250927);
    expect(arsenal.attack).toBeCloseTo(expected.get('A')!.attack!, 12);
    expect(arsenal.defence).toBeCloseTo(expected.get('A')!.defence!, 12);
    const chelsea = (await ratingsOf('Chelsea'))!;
    expect(chelsea).toMatchObject({ matches: 2, [BACKFILL_KEY]: 20250920 });
    expect(chelsea.attack).toBeCloseTo(expected.get('C')!.attack!, 12);
    expect(await ratingsOf('Tottenham')).toMatchObject({ matches: 1, [BACKFILL_KEY]: 20250927 });
    expect(await audits()).toBe(3);
  });

  it('is idempotent: the same file again changes and audits nothing', async () => {
    const before = await ratingsOf('Arsenal');
    const result = await cli.run(...BACKFILL);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 updated, 3 unchanged');
    expect(await ratingsOf('Arsenal')).toEqual(before);
    expect(await audits()).toBe(3);
  });

  it('refuses when live results have raised matches above the file, and writes nothing', async () => {
    await db.db.transaction((tx) =>
      setTeamRatings(
        tx,
        teamId('Chelsea'),
        { attack: 1.1, defence: 0.9, matches: 5 },
        { system: 't' },
      ),
    );
    // A file that would change the other teams too.
    cli.files.set(
      FILE,
      JSON.stringify([
        ...RESULTS,
        { ...RESULTS[0]!, date: '2025-10-04', home: 'Everton', away: 'Arsenal' },
      ]),
    );
    const arsenalBefore = await ratingsOf('Arsenal');
    const result = await cli.run(...BACKFILL);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/Chelsea .*REFUSED: matches 5 already exceeds the file's 2/);
    expect(result.stdout).toContain('nothing was written');
    expect(result.stdout).toContain('not written (another team was refused)');
    expect(await ratingsOf('Arsenal')).toEqual(arsenalBefore);
    expect(await ratingsOf('Everton')).not.toHaveProperty('matches');
  });

  it('refuses a team with manual = 1', async () => {
    await db.db.transaction((tx) =>
      setTeamRatings(
        tx,
        teamId('Liverpool'),
        { attack: 1.6, defence: 0.7, matches: 0, manual: 1 },
        { system: 't' },
      ),
    );
    cli.files.set(
      FILE,
      JSON.stringify([
        { date: '2025-08-16', home: 'Liverpool', away: 'Everton', homeGoals: 4, awayGoals: 0 },
      ]),
    );
    const before = await ratingsOf('Liverpool');
    const result = await cli.run(...BACKFILL);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('REFUSED: manual = 1');
    expect(await ratingsOf('Liverpool')).toEqual(before);
    expect(await ratingsOf('Everton')).not.toHaveProperty('matches');
    // --dry-run reports the refusal too, and still exits 1.
    const dry = await cli.run(...BACKFILL, '--dry-run');
    expect(dry.code).toBe(1);
    expect(dry.stdout).toContain('REFUSED: manual = 1');
  });

  it('refuses a file that ends before the date the team was last backfilled through', async () => {
    cli.files.set(
      FILE,
      JSON.stringify([
        { date: '2025-09-20', home: 'Chelsea', away: 'Brighton', homeGoals: 0, awayGoals: 0 },
      ]),
    );
    await db.db.transaction((tx) =>
      setTeamRatings(
        tx,
        teamId('Brighton'),
        { attack: 1, defence: 1, matches: 0, [BACKFILL_KEY]: 20251101 },
        { system: 't' },
      ),
    );
    const result = await cli.run(...BACKFILL);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('REFUSED: already backfilled through 20251101');
  });

  it('prints JSON with --json', async () => {
    cli.files.set(
      FILE,
      JSON.stringify([
        { date: '2025-08-16', home: 'Fulham', away: 'Brentford', homeGoals: 1, awayGoals: 1 },
      ]),
    );
    const result = await cli.run(...BACKFILL, '--dry-run', '--json');
    const body = JSON.parse(result.stdout) as {
      dryRun: boolean;
      teams: Array<{ team: string; status: string }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.teams.map((t) => [t.team, t.status])).toEqual([
      ['Brentford', 'would update'],
      ['Fulham', 'would update'],
    ]);
  });

  it('rejects bad input without touching the database', async () => {
    const check = async (data: unknown, message: string, code = 1) => {
      cli.files.set(FILE, typeof data === 'string' ? data : JSON.stringify(data));
      const result = await cli.run(...BACKFILL);
      expect(result.code).toBe(code);
      expect(result.stderr).toContain(message);
    };
    await check('nope', 'is not valid JSON');
    await check([], 'is not valid');
    await check([{ ...RESULTS[0]!, date: '2025-02-30' }], 'not a real date');
    await check([{ ...RESULTS[0]!, homeGoals: -1 }], 'homeGoals');
    await check([{ ...RESULTS[0]!, away: 'Chelsea' }], 'same team');
    await check([{ ...RESULTS[0]!, home: 'Nowhere United' }], 'unknown team "Nowhere United"');
    const unknown = await cli.run(
      'ratings',
      'backfill',
      '--file',
      FILE,
      '--competition',
      'no-such',
    );
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('no competition with slug "no-such"');
    expect((await cli.run('ratings', 'backfill', '--file', FILE)).code).toBe(2);
  });
});

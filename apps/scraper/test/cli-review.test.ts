import { openReviewItem } from '@vamos/db';
import { createTestDatabase } from '@vamos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliHarness } from './cli-helpers';
import { SETUP_TIMEOUT } from './helpers';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let cli: ReturnType<typeof cliHarness>;
beforeAll(async () => {
  db = await createTestDatabase();
  cli = cliHarness({ db: db.db });
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

const open = (kind: 'unknown_team' | 'odds_approval', subjectKey: string, now: Date) =>
  db.db.transaction((t) =>
    openReviewItem(t, { kind, subjectKey, severity: 'info', title: subjectKey, payload: {}, now }),
  );

describe('review counts', () => {
  it('prints every kind with its open count and oldest item, then the total', async () => {
    const empty = await cli.run('review', 'counts');
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('0 open review item(s)');

    await open('unknown_team', 'a', new Date('2030-03-02T10:00:00Z'));
    await open('unknown_team', 'b', new Date('2030-03-01T08:30:00Z'));
    await open('odds_approval', 'c', new Date('2030-03-05T00:00:00Z'));

    const run = await cli.run('review', 'counts');
    expect(run.code).toBe(0);
    const lines = run.stdout.split('\n');
    expect(lines[0]).toMatch(/^kind\s+open\s+oldest open$/);
    expect(lines.find((l) => l.startsWith('unknown_team'))).toMatch(
      /^unknown_team\s+2\s+2030-03-01T08:30:00\.000Z$/,
    );
    expect(lines.find((l) => l.startsWith('odds_approval'))).toMatch(
      /^odds_approval\s+1\s+2030-03-05T00:00:00\.000Z$/,
    );
    expect(lines.find((l) => l.startsWith('fixture_conflict'))).toMatch(
      /^fixture_conflict\s+0\s+-$/,
    );
    expect(lines.at(-1)).toBe('3 open review item(s)');
  });

  it('--json prints the same data', async () => {
    const run = await cli.run('review', 'counts', '--json');
    expect(run.code).toBe(0);
    const json = JSON.parse(run.stdout) as {
      kinds: { kind: string; count: number; oldestCreatedAt: string | null }[];
      total: number;
    };
    expect(json.total).toBe(3);
    expect(json.kinds.find((k) => k.kind === 'unknown_team')).toEqual({
      kind: 'unknown_team',
      count: 2,
      oldestCreatedAt: '2030-03-01T08:30:00.000Z',
    });
  });

  it('needs a sub-command and takes no arguments', async () => {
    expect((await cli.run('review')).code).toBe(2);
    expect((await cli.run('review', 'counts', 'extra')).code).toBe(2);
  });
});

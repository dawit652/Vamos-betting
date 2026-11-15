import { recordClosePrices, type ClosePrice } from '@vamos/db';
import { competitions, events, teams } from '@vamos/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Scorecard } from '../src/eval/scorecard';
import { catalogDatabase, cliHarness } from './cli-helpers';
import { HOUR, SETUP_TIMEOUT, T0 } from './helpers';

let db: Awaited<ReturnType<typeof catalogDatabase>>;
let cli: ReturnType<typeof cliHarness>;

const price = (overrides: Partial<ClosePrice>): ClosePrice => ({
  market: '1x2',
  line: null,
  selection: '1',
  pricingSource: 'market',
  ourOddsMilli: null,
  consensusPpm: null,
  pinnaclePpm: null,
  bestOddsMilli: null,
  bestBookmaker: null,
  books: 0,
  overroundPpm: null,
  ...overrides,
});

/** The 1X2 and over/under 2.5 rows of one event. */
function prices(source: 'model' | 'market', withPinnacle: boolean): ClosePrice[] {
  const one = (selection: '1' | 'X' | '2', odds: number, consensus: number, pinnacle: number) =>
    price({
      selection,
      pricingSource: source,
      ourOddsMilli: odds,
      consensusPpm: consensus,
      pinnaclePpm: withPinnacle ? pinnacle : null,
      bestOddsMilli: 1900,
      overroundPpm: 1_045_000,
    });
  const ou = (selection: 'over' | 'under', odds: number, consensus: number) =>
    price({
      market: 'ou',
      line: '2.5',
      selection,
      pricingSource: source,
      ourOddsMilli: odds,
      consensusPpm: consensus,
      overroundPpm: 1_050_000,
    });
  return [
    one('1', 2000, 480_000, 490_000),
    one('X', 3500, 280_000, 270_000),
    one('2', 4000, 240_000, 240_000),
    ou('over', 1900, 520_000),
    ou('under', 1950, 480_000),
  ];
}

beforeAll(async () => {
  db = await catalogDatabase();
  cli = cliHarness({ db: db.db });
  const [home, away] = await db.db.select({ id: teams.id }).from(teams).limit(2);
  const comps = await db.db
    .select({ id: competitions.id, sportId: competitions.sportId })
    .from(competitions)
    .where(eq(competitions.sportId, 'football'))
    .limit(2);
  if (home === undefined || away === undefined) throw new Error('no catalogue');
  const make = async (
    n: number,
    competition: string,
    status: 'finished' | 'scheduled',
    score: [number, number] | null,
    source: 'model' | 'market',
    pinnacle: boolean,
  ) => {
    const [row] = await db.db
      .insert(events)
      .values({
        gameId: 990_000 + n,
        sportId: 'football',
        competitionId: competition,
        homeTeamId: home.id,
        awayTeamId: away.id,
        startTime: new Date(T0.getTime() - 2 * HOUR),
        status,
        feedProvider: 'scraper',
        feedRef: `scorecard-test-${n}`,
        scoreHome: score?.[0] ?? null,
        scoreAway: score?.[1] ?? null,
        resultedAt: score === null ? null : new Date(T0.getTime() - HOUR),
      })
      .returning({ id: events.id });
    if (row === undefined) throw new Error('event not created');
    await db.db.transaction((tx) =>
      recordClosePrices(tx, row.id, prices(source, pinnacle), new Date(T0.getTime() - 3 * HOUR)),
    );
  };
  const [first, second] = comps;
  if (first === undefined || second === undefined) throw new Error('no catalogue');
  await make(1, first.id, 'finished', [2, 1], 'market', true); // home win, over 2.5
  await make(2, second.id, 'finished', [0, 0], 'model', false); // draw, under 2.5
  await make(3, first.id, 'scheduled', null, 'market', true); // pending
}, SETUP_TIMEOUT);
afterAll(async () => {
  await db?.drop();
}, SETUP_TIMEOUT);

describe('eval scorecard', () => {
  it('--json counts the sample and computes the scores of the captured prices', async () => {
    const run = await cli.run('eval', 'scorecard', '--days', '7', '--json');
    expect(run.code).toBe(0);
    const card = JSON.parse(run.stdout) as Scorecard & { from: string; to: string };
    expect(card.to).toBe(T0.toISOString());
    expect(card.from).toBe(new Date(T0.getTime() - 7 * 24 * HOUR).toISOString());
    expect(card.overall.sample).toEqual({ events: 3, settled: 2, void: 0, pending: 1 });
    expect(card.byCompetition).toHaveLength(2);
    expect(card.byPricingSource.map((g) => [g.source, g.section.sample.events])).toEqual([
      ['market', 2],
      ['model', 1],
    ]);

    // Our fair 1X2 is 1/2, 2/7, 1/4 over their sum 29/28: the home win gets 14/29.
    const fair = [0.5, 1000 / 3500, 0.25].map((x) => x / (0.5 + 1000 / 3500 + 0.25));
    const loss = (p: number) => -Math.log(p);
    const oneXTwo = card.overall.oneXTwo.oursVsConsensus;
    expect(oneXTwo.n).toBe(2);
    expect(oneXTwo.ours?.logLoss).toBeCloseTo((loss(fair[0]!) + loss(fair[1]!)) / 2, 10);
    expect(oneXTwo.consensus?.logLoss).toBeCloseTo((loss(0.48) + loss(0.28)) / 2, 10);
    expect(card.overall.oneXTwo.withPinnacle.n).toBe(1);
    expect(card.overall.oneXTwo.withPinnacle.pinnacle?.logLoss).toBeCloseTo(loss(0.49), 10);

    // Prices are measured on all three events, scored or not.
    expect(card.overall.prices.overround.oneXTwo.oursN).toBe(3);
    expect(card.overall.prices.overround.oneXTwo.oursMean).toBeCloseTo(
      0.5 + 1000 / 3500 + 0.25,
      10,
    );
    expect(card.overall.prices.overround.oneXTwo.consensusMean).toBeCloseTo(1.045, 10);
    expect(card.overall.prices.bestPrice).toEqual({ n: 9, shareAbove: 1, shareAtLeast: 1 });
    expect(card.overall.prices.edgeVsPinnacle.n).toBe(6);
  });

  it('prints one table per section', async () => {
    const run = await cli.run('eval', 'scorecard');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Sample (events with prices at close)');
    expect(run.stdout).toContain('Calibration of our 1X2');
    expect(run.stdout).toContain('Per competition');
    expect(run.stdout).toContain('Per pricing source');
    expect(run.stdout).toMatch(/^market\s+2\s+1\s+0\s+1\s/m);
  });

  it('an empty window prints dashes, and bad flags are a usage error', async () => {
    const empty = await cli.run('eval', 'scorecard', '--from', '2020-01-01', '--to', '2020-01-02');
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('-');
    expect(empty.stdout).not.toContain('NaN');
    for (const args of [
      ['--days', '0'],
      ['--days', '91'],
      ['--days', '1.5'],
      ['--days', '3', '--from', '2026-01-01'],
      ['--from', '2026-01-01'],
      ['--from', 'nonsense', '--to', '2026-01-02'],
      ['--from', '2026-01-02', '--to', '2026-01-01'],
      ['extra'],
    ]) {
      expect((await cli.run('eval', 'scorecard', ...args)).code).toBe(2);
    }
    expect((await cli.run('eval')).code).toBe(2);
  });
});

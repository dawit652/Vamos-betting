import { randomUUID } from 'node:crypto';
import { factoryMarket } from '@vamos/core';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultEvent, upsertFixture, type CatalogIds } from '../src/index';
import { markets, selections } from '../src/schema/index';
import { createBettingDatabase, type TestDb } from './betting-fixtures';
import { dropTestDatabase } from './helpers';

/**
 * Plan task 2.3 (money path, first part): football markets of the market factory can be stored
 * through upsertFixture and are settled by resultEvent with the same rule that priced them.
 * Nothing produces such markets yet; the catalogue views do not show unknown types.
 */

let handle: TestDb;
let ids: CatalogIds;

beforeAll(async () => {
  ({ handle, ids } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

function fixture() {
  const competitionId = ids.competitions.get('football/premier-league');
  const home = ids.teams.get('football/Arsenal');
  const away = ids.teams.get('football/Chelsea');
  if (competitionId === undefined || home === undefined || away === undefined) {
    throw new Error('seed is missing the premier league, Arsenal or Chelsea');
  }
  return {
    feedProvider: 'test-factory',
    feedRef: `factory:${randomUUID()}`,
    sport: 'football' as const,
    competitionId,
    homeTeamId: home,
    awayTeamId: away,
    startTime: new Date(Date.now() + 3 * 3_600_000),
  };
}

/** Every listed selection of a factory market at one price (enough to store and settle it). */
function priced(type: string, line: string | null, drop: readonly string[] = []) {
  return {
    type,
    line,
    selections: factoryMarket(type, line)
      .selections.filter((code) => !drop.includes(code))
      .map((code) => ({ code, oddsMilli: 2500 })),
  };
}

const ONE_X_TWO = {
  type: '1x2' as const,
  line: null,
  selections: [
    { code: '1', oddsMilli: 2100 },
    { code: 'X', oddsMilli: 3300 },
    { code: '2', oddsMilli: 3600 },
  ],
};

async function storedResults(eventId: string) {
  const rows = await handle.db
    .select({
      key: markets.key,
      status: markets.status,
      code: selections.code,
      result: selections.result,
    })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(eq(markets.eventId, eventId))
    .orderBy(asc(markets.sortOrder), asc(selections.sortOrder));
  const byKey = new Map<string, { status: string; results: Record<string, string | null> }>();
  for (const row of rows) {
    const entry = byKey.get(row.key) ?? { status: row.status, results: {} };
    entry.results[row.code] = row.result;
    byKey.set(row.key, entry);
  }
  return byKey;
}

describe('factory markets in the catalogue', () => {
  it('stores factory markets after today’s, with a subset of selections allowed', async () => {
    const created = await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture(), [
        ONE_X_TWO,
        priced('htft', null, ['2/1']),
        priced('multigoals', '1-3'),
      ]),
    );
    const rows = await handle.db
      .select({
        key: markets.key,
        type: markets.type,
        line: markets.line,
        sortOrder: markets.sortOrder,
      })
      .from(markets)
      .where(eq(markets.eventId, created.eventId))
      .orderBy(asc(markets.sortOrder));
    expect(rows.map((r) => r.key)).toEqual(['1x2', 'multigoals:1-3', 'htft']);
    expect(rows[1]?.sortOrder).toBeGreaterThanOrEqual(1000);
    const htft = await handle.db
      .select({ code: selections.code })
      .from(selections)
      .innerJoin(markets, eq(markets.id, selections.marketId))
      .where(eq(markets.key, 'htft'));
    expect(htft.map((s) => s.code)).not.toContain('2/1');
  });

  it('rejects unknown factory markets, lines and selections, and factory types outside football', async () => {
    const bad = [
      [{ type: 'htft', line: '2.5', selections: [{ code: '1/1', oddsMilli: 3000 }] }],
      [{ type: 'multigoals', line: '1-9', selections: [{ code: 'yes', oddsMilli: 3000 }] }],
      [{ type: 'htft', line: null, selections: [{ code: '1/3', oddsMilli: 3000 }] }],
      [{ type: 'htft', line: null, selections: [] }],
      [{ type: 'htft', line: null, selections: [{ code: '1/1', oddsMilli: 1000 }] }],
      [{ type: 'no_such_market', line: null, selections: [{ code: 'yes', oddsMilli: 3000 }] }],
    ];
    for (const marketsIn of bad) {
      await expect(
        handle.db.transaction((tx) => upsertFixture(tx, fixture(), marketsIn)),
      ).rejects.toThrow(RangeError);
    }
    await expect(
      handle.db.transaction((tx) =>
        upsertFixture(tx, { ...fixture(), sport: 'basketball' }, [priced('htft', null)]),
      ),
    ).rejects.toThrow(RangeError);
  });

  it('settles factory markets by their rule at full time', async () => {
    const created = await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture(), [
        ONE_X_TWO,
        priced('htft', null),
        priced('multigoals', '1-3'),
        priced('asian_total', '3'),
        priced('h2_1x2', null),
      ]),
    );
    // Half time 0-1, full time 2-1: X/1, three goals, second half 2-0.
    await handle.db.transaction((tx) =>
      resultEvent(tx, created.eventId, {
        status: 'finished',
        score: { home: 2, away: 1, htHome: 0, htAway: 1 },
      }),
    );
    const results = await storedResults(created.eventId);
    expect(results.get('1x2')?.results['1']).toBe('won');
    const htft = results.get('htft');
    expect(htft?.status).toBe('settled');
    expect(htft?.results['2/1']).toBe('won');
    expect(htft?.results['X/1']).toBe('lost');
    expect(results.get('multigoals:1-3')?.results).toEqual({ yes: 'won', no: 'lost' });
    // A push on the whole line: every selection void, and the market void.
    expect(results.get('asian_total:3')).toEqual({
      status: 'void',
      results: { over: 'void', under: 'void' },
    });
    expect(results.get('h2_1x2')?.results['1']).toBe('won');
  });

  it('voids every factory selection when the match is not played', async () => {
    const created = await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture(), [ONE_X_TWO, priced('htft', null)]),
    );
    await handle.db.transaction((tx) => resultEvent(tx, created.eventId, { status: 'postponed' }));
    const htft = (await storedResults(created.eventId)).get('htft');
    expect(Object.values(htft?.results ?? {}).every((r) => r === 'void')).toBe(true);
  });

  it('refuses to settle a half-time market without the half-time score, writing nothing', async () => {
    const created = await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture(), [ONE_X_TWO, priced('htft', null)]),
    );
    await expect(
      handle.db.transaction((tx) =>
        resultEvent(tx, created.eventId, { status: 'finished', score: { home: 1, away: 0 } }),
      ),
    ).rejects.toThrow(RangeError);
    const rows = await handle.db
      .select({ result: selections.result })
      .from(selections)
      .innerJoin(markets, eq(markets.id, selections.marketId))
      .where(inArray(markets.eventId, [created.eventId]));
    expect(rows.every((r) => r.result === null)).toBe(true);
  });
});

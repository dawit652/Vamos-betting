import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { OddsChangePolicy } from '@vamos/core';
import {
  applyLiveState,
  getBalance,
  loadGameSettings,
  placeBet,
  postTransaction,
  resultEvent,
  schema,
  setSelectionOdds,
  upsertFixture,
  type AccountRef,
  type Database,
  type GameSettings,
  type PlaceBetResult,
} from '@vamos/db';
import { eq } from 'drizzle-orm';
import type { WorkerTestContext } from './helpers';

/** Bet placement / settlement fixtures for worker tests (after packages/db/test/betting-fixtures.ts). */

let counter = 0;
const next = () => {
  counter += 1;
  return counter;
};

export const cash = (userId: string): AccountRef => ({ kind: 'player_cash', userId });

/** Inserts a minimal active player and returns its id. */
export async function createUser(db: Database): Promise<string> {
  const digits = `${randomInt(1_000, 9_999)}${String(next()).padStart(4, '0')}`;
  const [row] = await db
    .insert(schema.users)
    .values({
      phone: `+2519${digits}`,
      passwordHash: 'not-a-real-hash',
      dateOfBirth: '1990-01-01',
      status: 'active',
      termsAcceptedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  return row.id;
}

/** Credits play money to the player's cash account (a demo_topup posting). */
export async function fund(db: Database, userId: string, amount: bigint): Promise<void> {
  await db.transaction((tx) =>
    postTransaction(tx, {
      type: 'demo_topup',
      idempotencyKey: `topup:${userId}:${next()}:${randomUUID()}`,
      entries: [
        { account: { kind: 'house_demo_funding' }, amount: -amount },
        { account: cash(userId), amount },
      ],
    }),
  );
}

/** A funded player. */
export async function fundedUser(db: Database, amount = 100_000n): Promise<string> {
  const userId = await createUser(db);
  await fund(db, userId, amount);
  return userId;
}

/** Game settings as loaded from the database, with a short live bet delay for tests. */
export async function testSettings(db: Database, liveBetDelayMs = 6000): Promise<GameSettings> {
  return { ...(await loadGameSettings(db)), liveBetDelayMs };
}

export interface TestEvent {
  eventId: string;
  home: string;
  draw: string;
  away: string;
  over: string;
  under: string;
}

/** A prematch football fixture (kick-off in 3 h of `now`) with 1x2 and O/U 2.5. */
export async function createEvent(t: WorkerTestContext): Promise<TestEvent> {
  const lookup = (map: Map<string, string>, key: string) => {
    const value = map.get(key);
    if (value === undefined) throw new Error(`not seeded: ${key}`);
    return value;
  };
  const result = await t.db.db.transaction((tx) =>
    upsertFixture(
      tx,
      {
        feedProvider: 'test-feed',
        feedRef: `bet:${randomUUID()}`,
        sport: 'football',
        competitionId: lookup(t.ids.competitions, 'football/premier-league'),
        homeTeamId: lookup(t.ids.teams, 'football/Arsenal'),
        awayTeamId: lookup(t.ids.teams, 'football/Chelsea'),
        startTime: new Date(t.clock.now.getTime() + 3 * 3600_000),
      },
      [
        {
          type: '1x2',
          line: null,
          selections: [
            { code: '1', oddsMilli: 2000 },
            { code: 'X', oddsMilli: 3200 },
            { code: '2', oddsMilli: 3500 },
          ],
        },
        {
          type: 'ou',
          line: '2.5',
          selections: [
            { code: 'over', oddsMilli: 1900 },
            { code: 'under', oddsMilli: 1850 },
          ],
        },
      ],
    ),
  );
  const rows = await t.db.db
    .select({ id: schema.selections.id, code: schema.selections.code, type: schema.markets.type })
    .from(schema.selections)
    .innerJoin(schema.markets, eq(schema.markets.id, schema.selections.marketId))
    .where(eq(schema.markets.eventId, result.eventId));
  const find = (type: string, code: string) => {
    const row = rows.find((r) => r.type === type && r.code === code);
    if (row === undefined) throw new Error(`no ${type}/${code} selection`);
    return row.id;
  };
  return {
    eventId: result.eventId,
    home: find('1x2', '1'),
    draw: find('1x2', 'X'),
    away: find('1x2', '2'),
    over: find('ou', 'over'),
    under: find('ou', 'under'),
  };
}

/** Kicks the event off (status live, 0-0). */
export async function goLive(db: Database, eventId: string): Promise<void> {
  await db.transaction((tx) =>
    applyLiveState(tx, eventId, { status: 'live', minute: 1, period: '1H', home: 0, away: 0 }),
  );
}

/** Results the event as finished with the given score (a correction when already resulted). */
export async function finish(db: Database, eventId: string, home: number, away: number) {
  return db.transaction((tx) =>
    resultEvent(tx, eventId, { status: 'finished', score: { home, away } }),
  );
}

/** Moves one selection's price (as a trader would). */
export async function reprice(db: Database, selectionId: string, oddsMilli: number) {
  await db.transaction((tx) => setSelectionOdds(tx, [{ selectionId, oddsMilli, source: 'test' }]));
}

export interface PlaceOptions {
  stake: bigint;
  legs: Array<{ selectionId: string; oddsMilli: number }>;
  settings: GameSettings;
  now: Date;
  policy?: OddsChangePolicy;
}

/** placeBet in its own transaction. */
export async function place(
  db: Database,
  userId: string,
  options: PlaceOptions,
): Promise<PlaceBetResult> {
  return db.transaction((tx) =>
    placeBet(tx, {
      userId,
      legs: options.legs,
      stake: options.stake,
      policy: options.policy ?? 'none',
      idempotencyKey: `bet-key-${next()}-${randomUUID()}`,
      now: options.now,
      settings: options.settings,
      randomBytes: (n) => randomBytes(n),
    }),
  );
}

/** The player's cash and the house accounts settlement moves. */
export async function balances(db: Database, userId: string) {
  return {
    cash: await getBalance(db, cash(userId)),
    stakes: await getBalance(db, { kind: 'house_stakes' }),
    revenue: await getBalance(db, { kind: 'house_revenue' }),
    tax: await getBalance(db, { kind: 'house_tax_payable' }),
  };
}

/** The bet row as stored. */
export async function betRow(db: Database, betId: string) {
  const [row] = await db.select().from(schema.bets).where(eq(schema.bets.id, betId));
  if (row === undefined) throw new Error(`bet ${betId} not found`);
  return row;
}

/** Polls `check` until it returns true (or fails after `ms`). */
export async function eventually(
  check: () => Promise<boolean>,
  ms = 10_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

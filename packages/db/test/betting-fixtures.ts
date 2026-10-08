import { randomBytes, randomUUID } from 'node:crypto';
import type { OddsChangePolicy } from '@vamos/core';
import { eq } from 'drizzle-orm';
import {
  applyLiveState,
  getBalance,
  loadCatalogIds,
  loadGameSettings,
  placeBet,
  resultEvent,
  setSelectionOdds,
  upsertFixture,
  type AccountRef,
  type CatalogIds,
  type GameSettings,
  type PlaceBetResult,
} from '../src/index';
import type { Database } from '../src/client';
import { markets, selections } from '../src/schema/index';
import { seed } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { cash } from './helpers';

export type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

/** A migrated, seeded (house accounts, settings, catalogue) throwaway database. */
export async function createBettingDatabase(): Promise<{
  handle: TestDb;
  ids: CatalogIds;
  settings: GameSettings;
}> {
  const handle = await createTestDatabase();
  await seed(handle.db, { mode: 'demo' });
  return {
    handle,
    ids: await loadCatalogIds(handle.db),
    settings: await loadGameSettings(handle.db),
  };
}

export interface TestEvent {
  eventId: string;
  /** selection ids: 1x2 home/draw/away, over/under 2.5, draw-no-bet home/away. */
  home: string;
  draw: string;
  away: string;
  over: string;
  under: string;
  dnbHome: string;
  dnbAway: string;
  marketIds: { '1x2': string; ou: string; dnb: string };
}

export interface TestOdds {
  home?: number;
  draw?: number;
  away?: number;
  over?: number;
  under?: number;
  dnbHome?: number;
  dnbAway?: number;
}

function team(ids: CatalogIds, name: string): string {
  const id = ids.teams.get(`football/${name}`);
  if (id === undefined) throw new Error(`no seeded team ${name}`);
  return id;
}

/** A prematch football fixture (kick-off in 3 hours by default) with 1x2, O/U 2.5 and DNB. */
export async function createEvent(
  db: Database,
  ids: CatalogIds,
  options: { startTime?: Date; odds?: TestOdds } = {},
): Promise<TestEvent> {
  const odds = {
    home: 2000,
    draw: 3200,
    away: 3500,
    over: 1900,
    under: 1850,
    dnbHome: 1500,
    dnbAway: 2500,
    ...options.odds,
  };
  const competitionId = ids.competitions.get('football/premier-league');
  if (competitionId === undefined) throw new Error('no seeded premier-league');
  const result = await db.transaction((tx) =>
    upsertFixture(
      tx,
      {
        feedProvider: 'test-feed',
        feedRef: `bet:${randomUUID()}`,
        sport: 'football',
        competitionId,
        homeTeamId: team(ids, 'Arsenal'),
        awayTeamId: team(ids, 'Chelsea'),
        startTime: options.startTime ?? new Date(Date.now() + 3 * 3600_000),
      },
      [
        {
          type: '1x2',
          line: null,
          selections: [
            { code: '1', oddsMilli: odds.home },
            { code: 'X', oddsMilli: odds.draw },
            { code: '2', oddsMilli: odds.away },
          ],
        },
        {
          type: 'ou',
          line: '2.5',
          selections: [
            { code: 'over', oddsMilli: odds.over },
            { code: 'under', oddsMilli: odds.under },
          ],
        },
        {
          type: 'dnb',
          line: null,
          selections: [
            { code: '1', oddsMilli: odds.dnbHome },
            { code: '2', oddsMilli: odds.dnbAway },
          ],
        },
      ],
    ),
  );
  const rows = await db
    .select({ id: selections.id, code: selections.code, type: markets.type, marketId: markets.id })
    .from(selections)
    .innerJoin(markets, eq(markets.id, selections.marketId))
    .where(eq(markets.eventId, result.eventId));
  const find = (type: string, code: string) => {
    const row = rows.find((r) => r.type === type && r.code === code);
    if (row === undefined) throw new Error(`no ${type}/${code} selection`);
    return row;
  };
  return {
    eventId: result.eventId,
    home: find('1x2', '1').id,
    draw: find('1x2', 'X').id,
    away: find('1x2', '2').id,
    over: find('ou', 'over').id,
    under: find('ou', 'under').id,
    dnbHome: find('dnb', '1').id,
    dnbAway: find('dnb', '2').id,
    marketIds: {
      '1x2': find('1x2', '1').marketId,
      ou: find('ou', 'over').marketId,
      dnb: find('dnb', '1').marketId,
    },
  };
}

/** Kicks the event off (status live, 0-0). */
export async function goLive(db: Database, eventId: string): Promise<void> {
  await db.transaction((tx) =>
    applyLiveState(tx, eventId, { status: 'live', minute: 1, period: '1H', home: 0, away: 0 }),
  );
}

/** Results the event as finished with the given full-time score. */
export async function finish(
  db: Database,
  eventId: string,
  home: number,
  away: number,
): Promise<void> {
  await db.transaction((tx) =>
    resultEvent(tx, eventId, { status: 'finished', score: { home, away } }),
  );
}

/** Results the event as cancelled (every market void). */
export async function cancel(db: Database, eventId: string): Promise<void> {
  await db.transaction((tx) => resultEvent(tx, eventId, { status: 'cancelled' }));
}

/** Moves one selection's price (as a trader would). */
export async function reprice(db: Database, selectionId: string, oddsMilli: number) {
  await db.transaction((tx) => setSelectionOdds(tx, [{ selectionId, oddsMilli, source: 'test' }]));
}

let keyCounter = 0;
export function betKey(): string {
  keyCounter += 1;
  return `bet-key-${keyCounter}-${randomUUID()}`;
}

export interface PlaceOptions {
  stake: bigint;
  legs: Array<{ selectionId: string; oddsMilli: number }>;
  policy?: OddsChangePolicy;
  key?: string;
  now?: Date;
  settings: GameSettings;
}

/** placeBet in its own transaction with sensible defaults. */
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
      idempotencyKey: options.key ?? betKey(),
      now: options.now ?? new Date(),
      settings: options.settings,
      randomBytes: (n) => randomBytes(n),
    }),
  );
}

export const HOUSE = {
  stakes: { kind: 'house_stakes' } as AccountRef,
  revenue: { kind: 'house_revenue' } as AccountRef,
  tax: { kind: 'house_tax_payable' } as AccountRef,
};

/** Balances that settlement moves: the player's cash and the three house accounts. */
export async function balances(db: Database, userId: string) {
  return {
    cash: await getBalance(db, cash(userId)),
    stakes: await getBalance(db, HOUSE.stakes),
    revenue: await getBalance(db, HOUSE.revenue),
    tax: await getBalance(db, HOUSE.tax),
  };
}

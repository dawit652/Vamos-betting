import { randomUUID } from 'node:crypto';
import { birr, DEFAULT_TAX, type JackpotTemplate, type TaxConfig } from '@vamos/core';
import { eq } from 'drizzle-orm';
import {
  createJackpotRound,
  getBalance,
  placeJackpotEntry,
  settleJackpotRound,
  type CatalogIds,
  type JackpotRound,
  type PlaceJackpotEntryResult,
  type SettleJackpotRoundResult,
} from '../src/index';
import type { Database } from '../src/client';
import { jackpotEntries, ledgerTransactions } from '../src/schema/index';
import { cancel, createEvent, finish, type TestEvent } from './betting-fixtures';
import { cash } from './helpers';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/**
 * A small template for tests (3 games, 10 ETB a combination, at most 8):
 * 3 correct share 1,000 ETB; 2 correct win a fixed 20 ETB per combination.
 */
export function smallTemplate(overrides: Partial<JackpotTemplate> = {}): JackpotTemplate {
  return {
    code: 'daily9',
    enabled: true,
    gameCount: 3,
    costPerCombination: birr(10),
    maxCombinations: 8,
    cancelledRule: 'all_win',
    prizeTiers: [
      { correct: 3, kind: 'shared', amount: birr(1_000) },
      { correct: 2, kind: 'fixed', amount: birr(20) },
    ],
    ...overrides,
  };
}

/** `count` football fixtures with a 1X2 market, the first at `firstStart`, then every 15 minutes. */
export async function createGames(
  db: Database,
  ids: CatalogIds,
  count: number,
  firstStart: Date,
  spacingMs = 15 * MINUTE,
): Promise<TestEvent[]> {
  const games: TestEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    games.push(
      await createEvent(db, ids, { startTime: new Date(firstStart.getTime() + i * spacingMs) }),
    );
  }
  return games;
}

export interface OpenRoundOptions {
  template?: JackpotTemplate;
  tax?: TaxConfig;
  now?: Date;
  status?: 'open' | 'scheduled';
}

/** createJackpotRound in its own transaction (the small template and the default tax by default). */
export async function openRound(
  db: Database,
  games: readonly TestEvent[],
  options: OpenRoundOptions = {},
): Promise<JackpotRound> {
  return db.transaction((tx) =>
    createJackpotRound(tx, {
      template: options.template ?? smallTemplate(),
      tax: options.tax ?? DEFAULT_TAX,
      eventIds: games.map((game) => game.eventId),
      now: options.now ?? new Date(),
      ...(options.status === undefined ? {} : { status: options.status }),
    }),
  );
}

let keyCounter = 0;
export function jackpotKey(): string {
  keyCounter += 1;
  return `jp-key-${keyCounter}-${randomUUID()}`;
}

/** placeJackpotEntry in its own transaction. */
export async function enter(
  db: Database,
  userId: string,
  roundId: string,
  picks: ReadonlyArray<ReadonlyArray<string>>,
  options: { key?: string; now?: Date } = {},
): Promise<PlaceJackpotEntryResult> {
  return db.transaction((tx) =>
    placeJackpotEntry(tx, {
      userId,
      roundId,
      picks,
      idempotencyKey: options.key ?? jackpotKey(),
      now: options.now ?? new Date(),
    }),
  );
}

const SCORES = { '1': [2, 1], X: [1, 1], '2': [0, 1] } as const;

/** Results a game's event: finished with a score giving `result`, or cancelled (markets void). */
export async function resultGame(
  db: Database,
  game: TestEvent,
  result: '1' | 'X' | '2' | 'cancelled',
): Promise<void> {
  if (result === 'cancelled') {
    await cancel(db, game.eventId);
    return;
  }
  const [home, away] = SCORES[result];
  await finish(db, game.eventId, home, away);
}

/** settleJackpotRound in its own transaction. */
export async function settle(
  db: Database,
  roundId: string,
  now = new Date(),
): Promise<SettleJackpotRoundResult> {
  return db.transaction((tx) => settleJackpotRound(tx, roundId, now));
}

/** The balances jackpots move: house_jackpot and house_tax_payable. */
export async function houseBalances(db: Database) {
  return {
    jackpot: await getBalance(db, { kind: 'house_jackpot' }),
    tax: await getBalance(db, { kind: 'house_tax_payable' }),
  };
}

export async function cashOf(db: Database, userId: string): Promise<bigint> {
  return getBalance(db, cash(userId));
}

/** The entry row as stored. */
export async function entryRow(db: Database, entryId: string) {
  const [row] = await db.select().from(jackpotEntries).where(eq(jackpotEntries.id, entryId));
  if (row === undefined) throw new Error(`no jackpot entry ${entryId}`);
  return row;
}

/** The ledger transactions with a jackpot ref to the entry (payment, prize, refund). */
export async function entryPostings(db: Database, entryId: string) {
  return db
    .select({
      type: ledgerTransactions.type,
      idempotencyKey: ledgerTransactions.idempotencyKey,
    })
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.refId, entryId));
}

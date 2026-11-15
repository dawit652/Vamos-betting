import { birr } from '@vamos/core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, placeBet, type CatalogIds, type GameSettings } from '../src/index';
import {
  auditLog,
  betLegs,
  bets,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  outboxEvents,
} from '../src/schema/index';
import {
  createBettingDatabase,
  createEvent,
  goLive,
  place,
  reprice,
  type PlaceOptions,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';
import { countingDb, type CountedDb } from './query-counter';

/**
 * Round trips and results of placeBet.
 *
 * The statement budgets keep the bet path from growing database round trips again (docs/
 * load-testing.md: the API is CPU-bound on query building, so each statement costs throughput).
 * A budget counts every statement one placement sends, BEGIN and COMMIT included.
 *
 * The golden test pins everything a placement writes and returns (the bet row, its legs, the
 * stake's ledger transaction and entries, the outbox event, the audit record and the BetView),
 * with generated ids and database clock times replaced by placeholders. The snapshot was taken
 * before the bet path was trimmed (plan task A6); any difference is a change of behaviour.
 */

/**
 * Statements per placement, BEGIN and COMMIT included. Before plan task A6 both took 23 (the bet
 * was read back after it was inserted); a replay took 8, now 6.
 */
const SINGLE_BUDGET = 20;
const MULTI_BUDGET = 20;
const REPLAY_BUDGET = 6;

/** A fixed clock, so that every time a placement writes is reproducible. */
const NOW = new Date('2031-03-04T10:00:00.000Z');
const START = new Date(NOW.getTime() + 3 * 3600_000);

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;
let counted: CountedDb;
const events: TestEvent[] = [];

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
  for (let i = 0; i < 4; i += 1)
    events.push(await createEvent(handle.db, ids, { startTime: START }));
  counted = countingDb(handle.url);
});

afterAll(async () => {
  await counted?.close();
  await dropTestDatabase(handle);
});

async function player(amount = birr(1_000)): Promise<string> {
  const userId = await createUser(handle.db);
  if (amount > 0n) await fund(handle.db, userId, amount);
  return userId;
}

/** Deterministic bytes for the bet's short id (a different `seed` per bet). */
function bytes(seed: number) {
  return (size: number) => Uint8Array.from({ length: size }, (_, i) => (seed * 31 + i * 7) % 256);
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

/** Statements one call sends. */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
  counted.reset();
  await run().catch((error: unknown) => {
    if (!(error instanceof DomainError)) throw error;
  });
  return [...counted.statements];
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DAY_MS = 24 * 3600_000;

/**
 * JSON with sorted keys in which uuids become names (`known`, else `<uuid N>` in order of first
 * appearance), times near NOW become `NOW+<ms>`, other times (database clock) `<db time>`,
 * bigint serial ids `<serial>`, game ids `<game id>`, and bigints `<n>n`.
 */
function normalize(value: unknown, known: Record<string, string>): string {
  const names = new Map(Object.entries(known).map(([id, name]) => [id.toLowerCase(), name]));
  const walk = (v: unknown, key?: string): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (v instanceof Date) {
      const offset = v.getTime() - NOW.getTime();
      return Math.abs(offset) <= DAY_MS ? `NOW+${offset}` : '<db time>';
    }
    if (typeof v === 'bigint') return key === 'id' ? '<serial>' : `${v}n`;
    // Drawn at random per fixture; the event's id already says which match it is.
    if (key === 'gameId') return '<game id>';
    if (typeof v === 'string') {
      // Also inside strings such as ledger keys ('user:<uuid>:cash').
      return v.replace(UUID_RE, (match) => {
        const id = match.toLowerCase();
        if (!names.has(id)) names.set(id, `<uuid ${names.size}>`);
        return names.get(id) ?? match;
      });
    }
    if (Array.isArray(v)) return v.map((item) => walk(item));
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        out[k] = walk((v as Record<string, unknown>)[k], k);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value), null, 2);
}

/** Everything one bet wrote. */
async function written(betId: string) {
  const [bet] = await handle.db.select().from(bets).where(eq(bets.id, betId));
  const legs = await handle.db
    .select()
    .from(betLegs)
    .where(eq(betLegs.betId, betId))
    .orderBy(asc(betLegs.position));
  const transactions = await handle.db
    .select()
    .from(ledgerTransactions)
    .where(eq(ledgerTransactions.refId, betId));
  const inserted = await handle.db
    .select({ account: ledgerAccounts.key, entry: ledgerEntries })
    .from(ledgerEntries)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
    .where(eq(ledgerTransactions.refId, betId))
    .orderBy(asc(ledgerEntries.id));
  // postTransaction writes the entries in ascending account id order (its lock order). Account
  // ids are random per database, so the snapshot lists them by account key instead.
  const accountIds = inserted.map(({ entry }) => entry.accountId);
  expect(accountIds).toEqual([...accountIds].sort());
  const entries = [...inserted].sort((a, b) => (a.account < b.account ? -1 : 1));
  const outbox = await handle.db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, betId))
    .orderBy(asc(outboxEvents.id));
  const audit = await handle.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.targetId, betId))
    .orderBy(asc(auditLog.id));
  return { bet, legs, transactions, entries, outbox, audit };
}

function knownIds(userId: string, betId?: string): Record<string, string> {
  const known: Record<string, string> = { [userId]: '<user>' };
  if (betId !== undefined) known[betId] = '<bet>';
  events.forEach((event, i) => {
    known[event.eventId] = `<event ${i}>`;
    for (const name of ['home', 'draw', 'away', 'over', 'under', 'dnbHome', 'dnbAway'] as const) {
      known[event[name]] = `<event ${i} ${name}>`;
    }
    for (const [type, id] of Object.entries(event.marketIds)) known[id] = `<event ${i} ${type}>`;
  });
  return known;
}

function single(): Omit<PlaceOptions, 'settings'> {
  return { stake: birr(100), legs: [{ selectionId: events[0]!.home, oddsMilli: 2000 }], now: NOW };
}

function multi(): Omit<PlaceOptions, 'settings'> {
  return {
    stake: birr(50),
    legs: [
      { selectionId: events[1]!.home, oddsMilli: 2000 },
      { selectionId: events[2]!.over, oddsMilli: 1900 },
      { selectionId: events[3]!.away, oddsMilli: 3500 },
    ],
    now: NOW,
  };
}

describe('placeBet golden results (unchanged by plan task A6)', () => {
  it('a prematch single, then its idempotent replay', async () => {
    const userId = await player();
    const key = 'golden-single-0001';
    const options = { ...single(), settings, key };
    const placed = await handle.db.transaction((tx) =>
      placeBet(tx, {
        userId,
        legs: options.legs,
        stake: options.stake,
        policy: 'none',
        idempotencyKey: key,
        now: NOW,
        settings,
        randomBytes: bytes(1),
      }),
    );
    const replay = await place(handle.db, userId, { ...options, now: new Date(NOW.getTime() + 5) });
    expect(replay.replayed).toBe(true);
    expect(replay.bet).toEqual(placed.bet);
    const known = knownIds(userId, placed.bet.id);
    await expect(
      normalize({ placed, replay, written: await written(placed.bet.id) }, known),
    ).toMatchFileSnapshot('./__snapshots__/betting-place-golden.single.txt');
  });

  it('a three-leg multi with a bonus, one leg repriced (policy any), from the web with an ip', async () => {
    const userId = await player();
    await reprice(handle.db, events[2]!.over, 1950);
    try {
      const placed = await handle.db.transaction((tx) =>
        placeBet(tx, {
          userId,
          legs: multi().legs,
          stake: birr(50),
          policy: 'any',
          idempotencyKey: 'golden-multi-0001',
          now: NOW,
          settings,
          randomBytes: bytes(2),
          ip: '192.0.2.10',
        }),
      );
      expect(placed.bet.potentialBonus).toBeGreaterThan(0n);
      await expect(
        normalize(
          { placed, written: await written(placed.bet.id) },
          knownIds(userId, placed.bet.id),
        ),
      ).toMatchFileSnapshot('./__snapshots__/betting-place-golden.multi.txt');
    } finally {
      await reprice(handle.db, events[2]!.over, 1900);
    }
  });

  it('a live single by SMS: pending acceptance after the live delay', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids, { startTime: START });
    await goLive(handle.db, event.eventId);
    const placed = await handle.db.transaction((tx) =>
      placeBet(tx, {
        userId,
        legs: [{ selectionId: event.draw, oddsMilli: 3200 }],
        stake: birr(20),
        policy: 'none',
        channel: 'sms',
        idempotencyKey: 'golden-live-0001',
        now: NOW,
        settings,
        randomBytes: bytes(3),
      }),
    );
    expect(placed.bet.status).toBe('pending_acceptance');
    const known = {
      ...knownIds(userId, placed.bet.id),
      [event.eventId]: '<live event>',
      [event.draw]: '<live event draw>',
      [event.marketIds['1x2']]: '<live event 1x2>',
    };
    await expect(
      normalize({ placed, written: await written(placed.bet.id) }, known),
    ).toMatchFileSnapshot('./__snapshots__/betting-place-golden.live.txt');
  });

  it('insufficient funds: the same refusal and nothing written', async () => {
    const userId = await player(birr(5));
    const error = await refusal(
      place(handle.db, userId, { ...single(), stake: birr(6), settings, key: 'golden-poor-0001' }),
    );
    expect({
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    }).toEqual({
      status: 422,
      code: 'insufficient_funds',
      message: 'Your balance is too low for this stake.',
      details: { balance: '500', stake: '600' },
    });
    expect(await handle.db.select().from(bets).where(eq(bets.userId, userId))).toEqual([]);
    expect(
      await handle.db
        .select()
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotencyKey, `bet:${userId}:golden-poor-0001`)),
    ).toEqual([]);
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.actorId, userId))).toEqual([]);
  });
});

describe('placeBet statement budget', () => {
  it('a single stays within its budget', async () => {
    const userId = await player();
    const sent = await statementsOf(() => place(counted.db, userId, { ...single(), settings }));
    expect(sent.at(-1)).toBe('commit');
    expect(sent.length, sent.join('\n')).toBeLessThanOrEqual(SINGLE_BUDGET);
  });

  it('a three-leg multi stays within its budget (the legs do not add statements)', async () => {
    const userId = await player();
    const sent = await statementsOf(() => place(counted.db, userId, { ...multi(), settings }));
    expect(sent.at(-1)).toBe('commit');
    expect(sent.length, sent.join('\n')).toBeLessThanOrEqual(MULTI_BUDGET);
  });

  it('a replay and an insufficient-funds refusal stay within theirs', async () => {
    const userId = await player(birr(5));
    const key = 'budget-replay-0001';
    await place(handle.db, userId, { ...single(), stake: birr(5), settings, key });
    const replay = await statementsOf(() =>
      place(counted.db, userId, { ...single(), stake: birr(5), settings, key }),
    );
    expect(replay.at(-1)).toBe('commit');
    const refused = await statementsOf(() =>
      place(counted.db, userId, { ...single(), stake: birr(6), settings }),
    );
    expect(refused.at(-1)).toBe('rollback');
    expect(replay.length, replay.join('\n')).toBeLessThanOrEqual(REPLAY_BUDGET);
    expect(refused.length, refused.join('\n')).toBeLessThanOrEqual(SINGLE_BUDGET);
  });
});

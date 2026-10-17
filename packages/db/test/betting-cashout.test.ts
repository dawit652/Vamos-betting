import { birr, DEFAULT_TAX, type CashOutConfig } from '@vamos/core';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @vamos/db does not depend on @vamos/contracts; the source is imported only to
// check that the wire view built here matches the contract.
import {
  CashedOutView as CashedOutViewContract,
  CashOutOfferView as CashOutOfferViewContract,
  MAX_CASH_OUT_OFFERS,
  type CashOutUnavailableReason as ContractReason,
} from '../../contracts/src/cashout';
import {
  applyLiveState,
  cashedOutView,
  cashOutBet,
  cashOutOfferView,
  type CashOutUnavailable,
  DomainError,
  getBetById,
  getCashOutOffer,
  getCashOutOffers,
  getRemainingWagering,
  listBetsToSettle,
  loadWageringEvents,
  MAX_CASH_OUT_BATCH,
  prepareCashOut,
  resultMarket,
  setEventBettingOpen,
  setMarketStatus,
  settleEventBets,
  settleMarketBets,
  settlePlacedBet,
  type CashOutArrival,
  type CashOutBetResult,
  type CashOutQuote,
  type CatalogIds,
  type DbTransaction,
  type GameSettings,
  type UserBet,
} from '../src/index';
import {
  auditLog,
  betCashouts,
  ledgerAccounts,
  ledgerTransactions,
  outboxEvents,
  rgExclusions,
} from '../src/schema/index';
import {
  balances,
  cancel,
  createBettingDatabase,
  createEvent,
  finish,
  goLive,
  place,
  reprice,
  type TestDb,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund, pgCode, sleep } from './helpers';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;
let config: CashOutConfig;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
  config = settings.cashOut;
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const MARGIN_BPS = 500n;

async function player(amount = birr(10_000)): Promise<string> {
  const userId = await createUser(handle.db);
  await fund(handle.db, userId, amount);
  return userId;
}

/** A single on the event's home selection (2.00 by default), placed prematch. */
async function single(userId: string, stake: bigint, options: { odds?: number } = {}) {
  const odds = options.odds ?? 2000;
  const event = await createEvent(handle.db, ids, { odds: { home: odds } });
  const placed = await place(handle.db, userId, {
    stake,
    legs: [{ selectionId: event.home, oddsMilli: odds }],
    settings,
  });
  return { event, bet: placed.bet };
}

async function offerOf(
  userId: string,
  betId: string,
  options: { now?: Date; config?: CashOutConfig } = {},
) {
  const offer = await getCashOutOffer(handle.db, {
    userId,
    betId,
    config: options.config ?? config,
    now: options.now ?? new Date(),
  });
  if (offer === null) throw new Error(`no offer for bet ${betId}`);
  return offer;
}

let keyCounter = 0;
const cashOutKey = () => `cash-out-key-${(keyCounter += 1)}-${Date.now()}`;

function cashOut(
  userId: string,
  betId: string,
  quotedGross: bigint,
  options: { key?: string; config?: CashOutConfig; now?: Date; arrival?: CashOutArrival } = {},
): Promise<CashOutBetResult> {
  return handle.db.transaction((tx) =>
    cashOutBet(tx, {
      userId,
      betId,
      quotedGross,
      idempotencyKey: options.key ?? cashOutKey(),
      now: options.now ?? new Date(),
      config: options.config ?? config,
      ...(options.arrival === undefined ? {} : { arrival: options.arrival }),
      ip: '203.0.113.7',
    }),
  );
}

/**
 * A cash-out request arriving at `at` (prepareCashOut, as the API runs it
 * before waiting the live delay): the arrival record, the key and the time
 * the delay is over.
 */
async function arrive(userId: string, betId: string, quotedGross: bigint, at = new Date()) {
  const key = cashOutKey();
  const arrival = await prepareCashOut(handle.db, {
    userId,
    betId,
    quotedGross,
    idempotencyKey: key,
    config,
    liveDelayMs: settings.liveBetDelayMs,
    now: at,
  });
  return { arrival, key, after: new Date(at.getTime() + arrival.delayMs) };
}

/** An in-play cash-out the way the API makes it: arrive, wait the live delay, execute. */
async function cashOutInPlay(userId: string, betId: string, quotedGross: bigint) {
  const { arrival, key, after } = await arrive(userId, betId, quotedGross);
  expect(arrival.delayMs).toBe(settings.liveBetDelayMs);
  return cashOut(userId, betId, quotedGross, { key, now: after, arrival });
}

/** The DomainError a promise rejects with. */
async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

async function bet(id: string): Promise<UserBet> {
  const row = await getBetById(handle.db, id);
  if (row === null) throw new Error(`no bet ${id}`);
  return row;
}

/** The bet's own state (without the live snapshots of its selections). */
function betState(row: UserBet) {
  return {
    status: row.status,
    settlementVersion: row.settlementVersion,
    settledGrossPayout: row.settledGrossPayout,
    settledTax: row.settledTax,
    settledNetPayout: row.settledNetPayout,
    settledAt: row.settledAt,
    legs: row.legs.map((leg) => leg.state),
  };
}

/** Ledger transactions of a bet, oldest first: [type, idempotency key with the id masked]. */
async function postingsOf(betId: string) {
  const rows = await handle.db
    .select({ type: ledgerTransactions.type, key: ledgerTransactions.idempotencyKey })
    .from(ledgerTransactions)
    .where(and(eq(ledgerTransactions.refType, 'bet'), eq(ledgerTransactions.refId, betId)))
    .orderBy(ledgerTransactions.createdAt, ledgerTransactions.idempotencyKey);
  return rows.map((row) => [row.type, row.key.replace(betId, 'ID').replace(/^bet:.*$/, 'bet:…')]);
}

async function outboxOf(betId: string) {
  return handle.db
    .select({ type: outboxEvents.type, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, betId))
    .orderBy(outboxEvents.id);
}

/** Every ledger account together sums to zero. */
async function expectBooksBalanced(): Promise<void> {
  const [total] = await handle.db
    .select({ sum: sql<string>`COALESCE(SUM(${ledgerAccounts.balance}), 0)::text` })
    .from(ledgerAccounts);
  expect(total?.sum).toBe('0');
}

type Balances = Awaited<ReturnType<typeof balances>>;
function delta(before: Balances, after: Balances) {
  return {
    cash: after.cash - before.cash,
    stakes: after.stakes - before.stakes,
    revenue: after.revenue - before.revenue,
    tax: after.tax - before.tax,
  };
}

/**
 * The cash-out formula, written out: floor(stake × Π placed (won and open
 * legs) × (10 000 − margin) / (1000^won × Π current (open legs) × 10 000)).
 * Void legs drop out; no max-payout cap.
 */
function fairOffer(stake: bigint, won: number[], open: Array<[number, number]>): bigint {
  let num = stake * (10_000n - MARGIN_BPS);
  let den = 10_000n;
  for (const odds of won) {
    num *= BigInt(odds);
    den *= 1000n;
  }
  for (const [placed, current] of open) {
    num *= BigInt(placed);
    den *= BigInt(current);
  }
  return num / den;
}

/** The default tax written out: 20% of the winnings when they reach 100 ETB. */
function taxOn(stake: bigint, gross: bigint): bigint {
  const winnings = gross - stake;
  return winnings >= birr(100) ? (winnings * 2_000n) / 10_000n : 0n;
}

/** Locks waited on by any backend of the test database right now. */
async function lockWaits(): Promise<number> {
  const r = await handle.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return r.rows[0]?.n ?? 0;
}

async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 300 && (await lockWaits()) === 0; i += 1) await sleep(10);
  expect(await lockWaits()).toBeGreaterThan(0);
}

/**
 * Runs `work` in a transaction that stays open (its locks held) until
 * `release()`: `inside` resolves with the work's result before the COMMIT.
 */
function heldTransaction<T>(work: (tx: DbTransaction) => Promise<T>) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: (value: T) => void;
  let failed!: (error: unknown) => void;
  const inside = new Promise<T>((resolve, reject) => {
    entered = resolve;
    failed = reject;
  });
  const done = handle.db
    .transaction(async (tx) => {
      const result = await work(tx);
      entered(result);
      await held;
      return result;
    })
    .catch((error: unknown) => {
      failed(error);
      throw error;
    });
  return { inside, release, done };
}

/** Whether another session can take this row lock right now (NOWAIT probe). */
async function lockFree(
  table: 'events' | 'markets' | 'selections' | 'bets',
  id: string,
): Promise<boolean> {
  const client = await handle.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id]);
    return true;
  } catch (error) {
    if (pgCode(error) === '55P03') return false;
    throw error;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const suspendMarket = (marketId: string, status: 'open' | 'suspended' | 'closed') =>
  handle.db.transaction((tx) => setMarketStatus(tx, marketId, status));

describe('cash-out offers', () => {
  it('values an open single at stake × placed / live odds less the margin, untaxed below the exemption', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    await reprice(handle.db, event.home, 1500);
    const offer = await offerOf(userId, placed.id);
    // 10000 × 2000 × 9500 / (1500 × 10000) = 12 666.67 → 12 666 santim (126.66 ETB).
    const gross = fairOffer(birr(100), [], [[2000, 1500]]);
    expect(gross).toBe(12_666n);
    expect(offer).toMatchObject({
      betId: placed.id,
      userId,
      status: 'open',
      available: true,
      reason: null,
      gross,
      tax: 0n, // 26.66 ETB of winnings, under the 100 ETB exemption
      net: gross,
      potentialReturn: birr(200),
      marginBps: 500,
    });
    expect(offer.legs).toEqual([
      {
        legId: placed.legs[0]!.id,
        selectionId: event.home,
        state: 'open',
        placedOddsMilli: 2000,
        currentOddsMilli: 1500,
      },
    ]);
  });

  it('counts a won leg at its placed odds and a void leg at 1.00 before settlement has run', async () => {
    const userId = await player();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => createEvent(handle.db, ids)));
    const { bet: placed } = await place(handle.db, userId, {
      stake: birr(50),
      legs: [
        { selectionId: a!.home, oddsMilli: 2000 },
        { selectionId: b!.dnbHome, oddsMilli: 1500 },
        { selectionId: c!.away, oddsMilli: 3500 },
      ],
      settings,
    });
    await finish(handle.db, a!.eventId, 1, 0); // home won
    await cancel(handle.db, b!.eventId); // every market void
    await reprice(handle.db, c!.away, 2800);
    // No settlement has run: the legs are still open on the bet itself.
    expect((await bet(placed.id)).legs.map((leg) => leg.state)).toEqual(['open', 'open', 'open']);

    const offer = await offerOf(userId, placed.id);
    // 5000 × 2.000 × (void) × 3500 / 2800 × 0.95 = 11 875 santim.
    const gross = fairOffer(birr(50), [2000], [[3500, 2800]]);
    expect(gross).toBe(11_875n);
    expect(offer).toMatchObject({ available: true, gross, tax: 0n, net: gross });
    // 50 × 2.00 × 3.50: the void leg drops out of the potential return.
    expect(offer.potentialReturn).toBe(birr(350));
    expect(offer.legs.map((leg) => [leg.state, leg.currentOddsMilli])).toEqual([
      ['won', null],
      ['void', null],
      ['open', 2800],
    ]);

    const result = await cashOut(userId, placed.id, gross);
    expect(result.cashOut).toMatchObject({ gross, tax: 0n, net: gross });
    // The cash-out records the leg states it priced.
    expect(result.bet.legs.map((leg) => leg.state)).toEqual(['won', 'void', 'open']);
  });

  it('is unavailable once a leg has lost, even before settlement', async () => {
    const userId = await player();
    const [a, b] = await Promise.all([1, 2].map(() => createEvent(handle.db, ids)));
    const { bet: placed } = await place(handle.db, userId, {
      stake: birr(50),
      legs: [
        { selectionId: a!.home, oddsMilli: 2000 },
        { selectionId: b!.away, oddsMilli: 3500 },
      ],
      settings,
    });
    const before = await offerOf(userId, placed.id);
    await finish(handle.db, a!.eventId, 0, 2);
    expect(await offerOf(userId, placed.id)).toMatchObject({
      available: false,
      reason: 'leg_lost',
      gross: 0n,
      tax: 0n,
      net: 0n,
      potentialReturn: 0n,
    });
    expect(await domainError(cashOut(userId, placed.id, before.gross))).toMatchObject({
      status: 409,
      code: 'cashout_unavailable',
      details: { reason: 'leg_lost' },
    });
    expect((await bet(placed.id)).status).toBe('open');
  });

  it('is unavailable while a leg cannot be bet on: market suspended or closed, betting paused, kick-off passed', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    const available = await offerOf(userId, placed.id);
    expect(available.available).toBe(true);

    await suspendMarket(event.marketIds['1x2'], 'suspended');
    const suspended = await offerOf(userId, placed.id);
    expect(suspended).toMatchObject({ available: false, reason: 'leg_suspended', gross: 0n });
    expect(suspended.legs[0]?.currentOddsMilli).toBeNull();
    expect(await domainError(cashOut(userId, placed.id, available.gross))).toMatchObject({
      code: 'cashout_unavailable',
      details: { reason: 'leg_suspended' },
    });

    await suspendMarket(event.marketIds['1x2'], 'open');
    expect((await offerOf(userId, placed.id)).available).toBe(true);

    await handle.db.transaction((tx) => setEventBettingOpen(tx, event.eventId, false));
    expect((await offerOf(userId, placed.id)).reason).toBe('leg_suspended');
    await handle.db.transaction((tx) => setEventBettingOpen(tx, event.eventId, true));

    // The start time has passed but the match is not live yet.
    expect(
      (await offerOf(userId, placed.id, { now: new Date(Date.now() + 4 * 3600_000) })).reason,
    ).toBe('leg_suspended');

    await suspendMarket(event.marketIds['1x2'], 'closed');
    expect((await offerOf(userId, placed.id)).reason).toBe('leg_suspended');
  });

  it('only open bets can cash out: pending acceptance, settled and cashed-out bets cannot', async () => {
    const userId = await player();
    // Live: the bet waits for acceptance.
    const live = await createEvent(handle.db, ids);
    await goLive(handle.db, live.eventId);
    const { bet: pending } = await place(handle.db, userId, {
      stake: birr(20),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      settings,
    });
    expect(pending.status).toBe('pending_acceptance');
    expect(await offerOf(userId, pending.id)).toMatchObject({
      available: false,
      reason: 'bet_not_open',
      status: 'pending_acceptance',
    });
    expect(await domainError(cashOut(userId, pending.id, birr(10)))).toMatchObject({
      status: 409,
      code: 'cashout_unavailable',
      details: { reason: 'bet_not_open' },
    });

    // Settled.
    const { event, bet: settled } = await single(userId, birr(20));
    await finish(handle.db, event.eventId, 1, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
    expect(await offerOf(userId, settled.id)).toMatchObject({
      available: false,
      reason: 'bet_not_open',
      status: 'won',
    });
  });

  it('is unavailable when every leg is decided but the bet is not settled yet', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    await finish(handle.db, event.eventId, 2, 0);
    expect(await offerOf(userId, placed.id)).toMatchObject({
      available: false,
      reason: 'all_legs_settled',
      potentialReturn: birr(200),
    });
  });

  it('discounts the bet’s own capped return (its terms), not today’s max payout', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids, { odds: { home: 10_000 } });
    const capped: GameSettings = {
      ...settings,
      betRules: { ...settings.betRules, maxStake: birr(500), maxPayout: birr(500) },
    };
    const { bet: placed } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 10_000 }],
      settings: capped,
    });
    expect(placed.potentialGrossPayout).toBe(birr(500));
    // Today's rules (500 000 ETB) would offer 100 × 10 / 10 × 0.95 = 95 ETB; the bet
    // can never pay more than its 500 ETB, so the offer is 500 / 10 × 0.95 = 47.50 ETB.
    const offer = await offerOf(userId, placed.id);
    expect(offer).toMatchObject({
      available: true,
      gross: birr(47.5),
      tax: 0n,
      net: birr(47.5),
      potentialReturn: birr(500),
    });
    expect(fairOffer(birr(100), [], [[10_000, 10_000]])).toBe(birr(95));
  });

  it('never offers a bet away for nothing, and respects a disabled cash-out', async () => {
    const userId = await player();
    const { bet: placed } = await single(userId, birr(100));
    const free = await offerOf(userId, placed.id, {
      config: { enabled: true, marginBps: 10_000, minOffer: 0n },
    });
    expect(free).toMatchObject({ available: false, reason: 'below_minimum', gross: 0n });
    const disabled = { ...config, enabled: false };
    expect((await offerOf(userId, placed.id, { config: disabled })).reason).toBe('disabled');
    expect(
      await domainError(cashOut(userId, placed.id, birr(90), { config: disabled })),
    ).toMatchObject({ code: 'cashout_unavailable', details: { reason: 'disabled' } });
  });

  it('serves only the player’s own bets (one or a batch, in the order asked)', async () => {
    const userId = await player();
    const other = await player();
    const { bet: first } = await single(userId, birr(10));
    const { bet: second } = await single(userId, birr(20));
    const { bet: theirs } = await single(other, birr(30));
    expect(
      await getCashOutOffer(handle.db, { userId, betId: theirs.id, config, now: new Date() }),
    ).toBeNull();
    expect(
      await getCashOutOffer(handle.db, { userId, betId: 'not-a-bet', config, now: new Date() }),
    ).toBeNull();
    expect(await domainError(cashOut(userId, theirs.id, birr(1)))).toMatchObject({
      status: 404,
      code: 'not_found',
    });

    const offers = await getCashOutOffers(handle.db, {
      userId,
      betIds: [second.id, theirs.id, 'nope', first.id.toUpperCase(), second.id],
      config,
      now: new Date(),
    });
    expect(offers.map((offer: CashOutQuote) => offer.betId)).toEqual([second.id, first.id]);
    expect(offers.every((offer) => offer.available)).toBe(true);
    await expect(
      getCashOutOffers(handle.db, {
        userId,
        betIds: Array.from({ length: MAX_CASH_OUT_BATCH + 1 }, () => first.id),
        config,
        now: new Date(),
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe('cash-out execution', () => {
  it('pays the offer in one bet_cashout transaction: tax on the profit, stakes and revenue reconcile', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(1_000), { odds: 3000 });
    await reprice(handle.db, event.home, 1200);
    const offer = await offerOf(userId, placed.id);
    // 100000 × 3000 × 9500 / (1200 × 10000) = 237 500 (2 375 ETB); 1 375 ETB of
    // winnings taxed at 20% = 275 ETB; the player receives 2 100 ETB.
    const gross = fairOffer(birr(1_000), [], [[3000, 1200]]);
    expect(gross).toBe(birr(2_375));
    expect(offer).toMatchObject({ gross, tax: taxOn(birr(1_000), gross), net: birr(2_100) });
    expect(offer.tax).toBe(birr(275));

    const before = await balances(handle.db, userId);
    const now = new Date();
    const key = cashOutKey();
    const result = await cashOut(userId, placed.id, offer.gross, { key, now });
    expect(result.replayed).toBe(false);
    expect(result.cashOut).toEqual({
      gross: birr(2_375),
      tax: birr(275),
      net: birr(2_100),
      cashedOutAt: now,
    });
    expect(result.bet).toMatchObject({
      status: 'cashed_out',
      settledGrossPayout: birr(2_375),
      settledTax: birr(275),
      settledNetPayout: birr(2_100),
      settledAt: now,
      cashedOut: result.cashOut,
    });
    expect(placed.cashedOut).toBeNull();
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: birr(2_100),
      stakes: -birr(1_000),
      revenue: -birr(1_375),
      tax: birr(275),
    });
    expect(await postingsOf(placed.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_cashout', 'cashout:ID'],
    ]);
    const [record] = await handle.db
      .select()
      .from(betCashouts)
      .where(eq(betCashouts.betId, placed.id));
    expect(record).toMatchObject({
      userId,
      idempotencyKey: key,
      quotedGross: birr(2_375),
      gross: birr(2_375),
      tax: birr(275),
      net: birr(2_100),
      marginBps: 500,
      legs: [
        {
          legId: placed.legs[0]!.id,
          selectionId: event.home,
          state: 'open',
          placedOddsMilli: 3000,
          currentOddsMilli: 1200,
        },
      ],
    });
    const outbox = await outboxOf(placed.id);
    expect(outbox.map((row) => row.type)).toEqual(['bet.placed', 'bet.cashed_out']);
    expect(outbox[1]?.payload).toEqual({
      betId: placed.id,
      userId,
      shortId: placed.shortId,
      stake: '100000',
      quotedGross: '237500',
      gross: '237500',
      tax: '27500',
      net: '210000',
      cashedOutAt: now.toISOString(),
    });
    const audits = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, placed.id), eq(auditLog.action, 'bet.cashed_out')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'user', actorId: userId });
    await expectBooksBalanced();
  });

  it('a cash-out below the stake takes no tax and leaves the difference in revenue', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    await reprice(handle.db, event.home, 4000);
    const gross = fairOffer(birr(100), [], [[2000, 4000]]);
    expect(gross).toBe(birr(47.5));
    const before = await balances(handle.db, userId);
    const result = await cashOut(userId, placed.id, gross);
    expect(result.cashOut).toMatchObject({ gross, tax: 0n, net: gross });
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: birr(47.5),
      stakes: -birr(100),
      revenue: birr(52.5),
      tax: 0n,
    });
    // No zero entry for the tax.
    const [posting] = await handle.db
      .select({ id: ledgerTransactions.id })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `cashout:${placed.id}`));
    const entries = await handle.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1',
      [posting!.id],
    );
    expect(entries.rows[0]?.n).toBe(3);
    await expectBooksBalanced();
  });

  it('refuses when the offer dropped (409 with the fresh offer, nothing written) and pays a higher fresh offer', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100), { odds: 3000 });
    await reprice(handle.db, event.home, 2000);
    const seen = await offerOf(userId, placed.id); // 100 × 3 / 2 × 0.95 = 142.50 ETB
    expect(seen.gross).toBe(birr(142.5));

    // The price shortens against the player: 100 × 3 / 2.5 × 0.95 = 114 ETB.
    await reprice(handle.db, event.home, 2500);
    const before = await balances(handle.db, userId);
    const changed = await domainError(cashOut(userId, placed.id, seen.gross));
    expect(changed).toMatchObject({
      status: 409,
      code: 'cashout_offer_changed',
      details: {
        offer: {
          betId: placed.id,
          available: true,
          reason: null,
          gross: '11400',
          tax: '0',
          net: '11400',
          potentialReturn: '30000',
        },
      },
    });
    expect((await bet(placed.id)).status).toBe('open');
    expect(await balances(handle.db, userId)).toEqual(before);
    expect(await postingsOf(placed.id)).toEqual([['bet_stake', 'bet:…']]);

    // The player accepts 114 ETB, and by then it has moved up to 100 × 3 / 1.5 × 0.95 = 190 ETB.
    await reprice(handle.db, event.home, 1500);
    const result = await cashOut(userId, placed.id, birr(114));
    expect(result.cashOut).toMatchObject({ gross: birr(190), tax: 0n, net: birr(190) });
    const [record] = await handle.db
      .select({ quoted: betCashouts.quotedGross, gross: betCashouts.gross })
      .from(betCashouts)
      .where(eq(betCashouts.betId, placed.id));
    expect(record).toEqual({ quoted: birr(114), gross: birr(190) });
  });

  it('refuses a higher gross that pays the player less net (the tax exemption threshold)', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids, { odds: { home: 3000 } });
    // Winnings under 80 ETB are not taxed under this bet's terms.
    const terms: GameSettings = {
      ...settings,
      tax: { rateBps: 2_000, base: 'net_winnings', exemptBelow: birr(80) },
    };
    const { bet: placed } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 3000 }],
      settings: terms,
    });
    await reprice(handle.db, event.home, 1500);
    // Fresh: 100 × 3 / 1.5 × 0.95 = 190 ETB gross, 90 ETB winnings taxed 18 ETB: 172 ETB net.
    expect(await offerOf(userId, placed.id)).toMatchObject({
      gross: birr(190),
      tax: birr(18),
      net: birr(172),
    });
    // The player saw 179.99 ETB (79.99 of winnings, untaxed): a higher gross would pay less.
    const refused = await domainError(cashOut(userId, placed.id, birr(179.99)));
    expect(refused).toMatchObject({
      code: 'cashout_offer_changed',
      details: { offer: { gross: '19000', tax: '1800', net: '17200' } },
    });
    expect((await bet(placed.id)).status).toBe('open');
    // Accepting the taxed amounts goes through.
    const result = await cashOut(userId, placed.id, birr(190));
    expect(result.cashOut).toMatchObject({ gross: birr(190), tax: birr(18), net: birr(172) });
    expect(DEFAULT_TAX.exemptBelow).toBe(birr(100));
  });

  it('a replay with the same key returns the same cash-out; other keys and other uses are refused', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    const { bet: another } = await single(userId, birr(10));
    await reprice(handle.db, event.home, 1600);
    const offer = await offerOf(userId, placed.id);
    const key = cashOutKey();
    const first = await cashOut(userId, placed.id, offer.gross, { key });
    const snapshot = async () => ({
      balances: await balances(handle.db, userId),
      postings: await postingsOf(placed.id),
      outbox: (await outboxOf(placed.id)).map((row) => row.type),
      audits: (
        await handle.db
          .select({ n: count() })
          .from(auditLog)
          .where(eq(auditLog.targetId, placed.id))
      )[0]?.n,
    });
    const before = await snapshot();

    // The odds moved since: the replay still returns what was paid.
    await reprice(handle.db, event.home, 1200);
    const replay = await cashOut(userId, placed.id, offer.gross, { key });
    expect(replay.replayed).toBe(true);
    expect(replay.cashOut).toEqual(first.cashOut);
    expect(betState(replay.bet)).toEqual(betState(first.bet));
    expect(await snapshot()).toEqual(before);

    // Same key, another amount or another bet: 422.
    expect(await domainError(cashOut(userId, placed.id, offer.gross - 1n, { key }))).toMatchObject({
      status: 422,
      code: 'idempotency_key_reused',
    });
    expect(await domainError(cashOut(userId, another.id, birr(9), { key }))).toMatchObject({
      status: 422,
      code: 'idempotency_key_reused',
    });
    // Another key on the cashed-out bet: 409.
    expect(await domainError(cashOut(userId, placed.id, offer.gross))).toMatchObject({
      status: 409,
      code: 'cashout_unavailable',
      details: { reason: 'bet_not_open' },
    });
    expect(await snapshot()).toEqual(before);
    // The same key may be used by another player.
    const other = await player();
    const { bet: theirs } = await single(other, birr(10));
    const theirOffer = await offerOf(other, theirs.id);
    expect((await cashOut(other, theirs.id, theirOffer.gross, { key })).replayed).toBe(false);
  });

  it('concurrent cash-outs of one bet pay exactly once', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    await reprice(handle.db, event.home, 1800);
    const offer = await offerOf(userId, placed.id);
    const before = await balances(handle.db, userId);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => cashOut(userId, placed.id, offer.gross)),
    );
    const paid = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(paid).toHaveLength(1);
    for (const r of refused) {
      expect(r.reason).toMatchObject({
        code: 'cashout_unavailable',
        details: { reason: 'bet_not_open' },
      });
    }
    expect(delta(before, await balances(handle.db, userId)).cash).toBe(offer.net);
    expect(await postingsOf(placed.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_cashout', 'cashout:ID'],
    ]);
    const [records] = await handle.db
      .select({ n: count() })
      .from(betCashouts)
      .where(eq(betCashouts.betId, placed.id));
    expect(records?.n).toBe(1);

    // The same key sent twice at once: one cash-out, one replay.
    const { event: e2, bet: second } = await single(userId, birr(100));
    await reprice(handle.db, e2.home, 1800);
    const key = cashOutKey();
    const both = await Promise.all([
      cashOut(userId, second.id, offer.gross, { key }),
      cashOut(userId, second.id, offer.gross, { key }),
    ]);
    expect(both.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(both[0].cashOut).toEqual(both[1].cashOut);
    expect(await postingsOf(second.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_cashout', 'cashout:ID'],
    ]);
    await expectBooksBalanced();
  });

  it('refuses a quoted amount that is not positive, writing nothing', async () => {
    const userId = await player();
    const { bet: placed } = await single(userId, birr(100));
    const before = await balances(handle.db, userId);
    for (const quotedGross of [0n, -1n]) {
      expect(await domainError(cashOut(userId, placed.id, quotedGross))).toMatchObject({
        status: 422,
        code: 'invalid_amount',
      });
    }
    expect((await bet(placed.id)).status).toBe('open');
    expect(await balances(handle.db, userId)).toEqual(before);
    expect(await postingsOf(placed.id)).toEqual([['bet_stake', 'bet:…']]);
  });

  it('self-excluded players may still cash out (it is not a stake)', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    await handle.db.insert(rgExclusions).values({
      userId,
      kind: 'self_exclusion',
      startsAt: new Date(Date.now() - 60_000),
      endsAt: null,
    });
    // Betting is refused...
    await expect(single(userId, birr(10))).rejects.toMatchObject({ status: 403 });
    // ...cashing out is not.
    await reprice(handle.db, event.home, 1900);
    const offer = await offerOf(userId, placed.id);
    const result = await cashOut(userId, placed.id, offer.gross);
    expect(result.bet.status).toBe('cashed_out');
  });
});

/** Writes the live score of a live event, as the simulator does each tick. */
async function setLiveScore(eventId: string, home: number, away: number): Promise<void> {
  await handle.db.transaction((tx) =>
    applyLiveState(tx, eventId, { status: 'live', minute: 30, period: '1H', home, away }),
  );
}

describe('cash-out in play', () => {
  it('prices a live leg at its in-play odds and pays it', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids);
    const { bet: placed } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    await goLive(handle.db, event.eventId);
    await setLiveScore(event.eventId, 1, 0);
    await reprice(handle.db, event.home, 1250);
    // 100 × 2.00 / 1.25 × 0.95 = 152 ETB: 52 ETB of winnings, under the tax exemption.
    const gross = fairOffer(birr(100), [], [[2000, 1250]]);
    expect(gross).toBe(birr(152));
    expect(await offerOf(userId, placed.id)).toMatchObject({
      available: true,
      gross,
      tax: 0n,
      net: gross,
    });
    const before = await balances(handle.db, userId);
    const result = await cashOutInPlay(userId, placed.id, gross);
    expect(result.cashOut).toMatchObject({ gross, tax: 0n, net: gross });
    expect(delta(before, await balances(handle.db, userId))).toEqual({
      cash: gross,
      stakes: -birr(100),
      revenue: birr(100) - gross,
      tax: 0n,
    });
    await expectBooksBalanced();
  });

  it('counts a leg on a market resulted early as decided at once', async () => {
    const userId = await player();
    const [a, b] = await Promise.all([1, 2].map(() => createEvent(handle.db, ids)));
    const { bet: acca } = await place(handle.db, userId, {
      stake: birr(50),
      legs: [
        { selectionId: a!.over, oddsMilli: 1900 },
        { selectionId: b!.home, oddsMilli: 2000 },
      ],
      settings,
    });
    const { bet: under } = await place(handle.db, userId, {
      stake: birr(50),
      legs: [{ selectionId: a!.under, oddsMilli: 1850 }],
      settings,
    });
    await goLive(handle.db, a!.eventId);
    await setLiveScore(a!.eventId, 2, 1);
    await handle.db.transaction((tx) =>
      resultMarket(tx, a!.marketIds.ou, { score: { home: 2, away: 1 } }),
    );
    // No settlement has run: over 2.5 counts as won at its 1.90, under 2.5 as lost.
    // 5000 × 1.900 × 2000 / 2000 × 0.95 = 9 025 santim.
    const gross = fairOffer(birr(50), [1900], [[2000, 2000]]);
    expect(gross).toBe(birr(90.25));
    const offer = await offerOf(userId, acca.id);
    expect(offer).toMatchObject({ available: true, gross, potentialReturn: birr(190) });
    expect(offer.legs.map((leg) => leg.state)).toEqual(['won', 'open']);
    expect(await offerOf(userId, under.id)).toMatchObject({
      available: false,
      reason: 'leg_lost',
    });
  });

  it('an early market result waits for a cash-out in progress; the bet then stays cashed out', async () => {
    const userId = await player();
    const event = await createEvent(handle.db, ids);
    const { bet: placed } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.over, oddsMilli: 1900 }],
      settings,
    });
    const { bet: other } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.under, oddsMilli: 1850 }],
      settings,
    });
    await goLive(handle.db, event.eventId);
    await setLiveScore(event.eventId, 2, 1);
    const offer = await offerOf(userId, placed.id);
    expect(offer.available).toBe(true);
    const { arrival, key, after } = await arrive(userId, placed.id, offer.gross);
    const held = heldTransaction((tx) =>
      cashOutBet(tx, {
        userId,
        betId: placed.id,
        quotedGross: offer.gross,
        idempotencyKey: key,
        now: after,
        config,
        arrival,
      }),
    );
    await held.inside;
    expect(await lockFree('markets', event.marketIds.ou)).toBe(false);
    const resulting = handle.db
      .transaction((tx) => resultMarket(tx, event.marketIds.ou, { score: { home: 2, away: 1 } }))
      .then(
        (result) => result.outcome,
        (error: unknown) => error,
      );
    await waitForLockWait();
    held.release();
    await held.done;
    expect(await resulting).toBe('resulted');
    // The market.resulted job settles the other bet and leaves the cashed-out one alone.
    expect(
      await handle.db.transaction((tx) => settleMarketBets(tx, event.marketIds.ou, new Date())),
    ).toMatchObject({ bets: 1, outcomes: { settled: 1 } });
    expect((await bet(placed.id)).status).toBe('cashed_out');
    expect((await bet(other.id)).status).toBe('lost');
    expect(await postingsOf(placed.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_cashout', 'cashout:ID'],
    ]);
    await expectBooksBalanced();
  });

  it('a market status change waits for a cash-out in progress', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    const offer = await offerOf(userId, placed.id);
    const held = heldTransaction((tx) =>
      cashOutBet(tx, {
        userId,
        betId: placed.id,
        quotedGross: offer.gross,
        idempotencyKey: cashOutKey(),
        now: new Date(),
        config,
      }),
    );
    await held.inside;
    const suspending = suspendMarket(event.marketIds['1x2'], 'suspended').then(
      (change) => change.changed,
      (error: unknown) => error,
    );
    await waitForLockWait();
    held.release();
    await held.done;
    expect(await suspending).toBe(true);
    expect((await bet(placed.id)).status).toBe('cashed_out');
  });
});

describe('cash-out in play: the live delay', () => {
  /** A single at 2.00 on the home win of a live match at 0-0, repriced to 1.25. */
  async function liveSingle(userId: string) {
    const event = await createEvent(handle.db, ids);
    const { bet: placed } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
    });
    await goLive(handle.db, event.eventId);
    await reprice(handle.db, event.home, 1250);
    const offer = await offerOf(userId, placed.id);
    expect(offer).toMatchObject({
      available: true,
      gross: fairOffer(birr(100), [], [[2000, 1250]]),
    });
    return { event, bet: placed, offer };
  }

  async function cashOutCount(betId: string): Promise<number> {
    const [row] = await handle.db
      .select({ n: count() })
      .from(betCashouts)
      .where(eq(betCashouts.betId, betId));
    return row?.n ?? 0;
  }

  it('pays a live leg only after the live bet delay, when nothing changed meanwhile', async () => {
    const userId = await player();
    const { event, bet: placed, offer } = await liveSingle(userId);

    // Straight to execution (no delay waited): refused with the offer, nothing written.
    const direct = await domainError(cashOut(userId, placed.id, offer.gross));
    expect(direct).toMatchObject({
      status: 409,
      code: 'cashout_offer_changed',
      details: { offer: { available: true, gross: offer.gross.toString() } },
    });
    expect(await postingsOf(placed.id)).toEqual([['bet_stake', 'bet:…']]);

    const at = new Date();
    const { arrival, key, after } = await arrive(userId, placed.id, offer.gross, at);
    expect(arrival).toMatchObject({ receivedAt: at, delayMs: settings.liveBetDelayMs });
    expect(arrival.liveLegs.map((leg) => leg.selectionId)).toEqual([event.home]);
    // Before the delay is over: refused.
    const early = new Date(after.getTime() - 1);
    expect(
      await domainError(cashOut(userId, placed.id, offer.gross, { key, now: early, arrival })),
    ).toMatchObject({ status: 409, code: 'cashout_offer_changed' });
    // The match clock moving on (no goal) changes nothing that matters.
    await handle.db.transaction((tx) =>
      applyLiveState(tx, event.eventId, {
        status: 'live',
        minute: 7,
        period: '1H',
        home: 0,
        away: 0,
      }),
    );
    const result = await cashOut(userId, placed.id, offer.gross, { key, now: after, arrival });
    expect(result.cashOut).toMatchObject({ gross: offer.gross, cashedOutAt: after });
    expect((await bet(placed.id)).status).toBe('cashed_out');
    await expectBooksBalanced();
  });

  it.each([
    ['its odds move, even for the better', 'cashout_offer_changed'],
    ['its market is suspended and re-opened at the same odds', 'cashout_offer_changed'],
    ['a goal is scored', 'cashout_offer_changed'],
    ['betting on the match is paused and resumed', 'cashout_offer_changed'],
    ['its market is suspended', 'cashout_unavailable'],
  ] as const)(
    'refuses when, during the delay, %s (409 %s, nothing written)',
    async (change, code) => {
      const userId = await player();
      const { event, bet: placed, offer } = await liveSingle(userId);
      const { arrival, key, after } = await arrive(userId, placed.id, offer.gross);
      const marketId = event.marketIds['1x2'];
      switch (change) {
        case 'its odds move, even for the better':
          await reprice(handle.db, event.home, 1200);
          break;
        case 'its market is suspended and re-opened at the same odds':
          await suspendMarket(marketId, 'suspended');
          await suspendMarket(marketId, 'open');
          break;
        case 'a goal is scored':
          await setLiveScore(event.eventId, 1, 0);
          break;
        case 'betting on the match is paused and resumed':
          await handle.db.transaction((tx) => setEventBettingOpen(tx, event.eventId, false));
          await handle.db.transaction((tx) => setEventBettingOpen(tx, event.eventId, true));
          break;
        case 'its market is suspended':
          await suspendMarket(marketId, 'suspended');
          break;
      }
      const error = await domainError(
        cashOut(userId, placed.id, offer.gross, { key, now: after, arrival }),
      );
      expect(error).toMatchObject({ status: 409, code });
      if (code === 'cashout_offer_changed') {
        // The fresh offer comes with it, to confirm again.
        const fresh = await offerOf(userId, placed.id, { now: after });
        expect(error.details).toEqual({ offer: cashOutOfferView(fresh) });
      }
      expect((await bet(placed.id)).status).toBe('open');
      expect(await postingsOf(placed.id)).toEqual([['bet_stake', 'bet:…']]);
      expect(await cashOutCount(placed.id)).toBe(0);
    },
  );

  it('refuses a leg whose match kicked off after the request arrived (no delay was waited)', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    const offer = await offerOf(userId, placed.id);
    const { arrival, key, after } = await arrive(userId, placed.id, offer.gross);
    // Prematch only: no delay.
    expect(arrival).toMatchObject({ delayMs: 0, liveLegs: [] });
    await goLive(handle.db, event.eventId);
    expect(
      await domainError(cashOut(userId, placed.id, offer.gross, { key, now: after, arrival })),
    ).toMatchObject({ status: 409, code: 'cashout_offer_changed' });
    expect((await bet(placed.id)).status).toBe('open');
    expect(await cashOutCount(placed.id)).toBe(0);
  });

  it('a leg decided in play and a prematch leg need no delay; an open live leg does', async () => {
    const userId = await player();
    const [a, b] = await Promise.all([1, 2].map(() => createEvent(handle.db, ids)));
    const { bet: acca } = await place(handle.db, userId, {
      stake: birr(50),
      legs: [
        { selectionId: a!.over, oddsMilli: 1900 },
        { selectionId: b!.home, oddsMilli: 2000 },
      ],
      settings,
    });
    await goLive(handle.db, a!.eventId);
    await setLiveScore(a!.eventId, 2, 1);
    const offer = await offerOf(userId, acca.id);
    expect((await arrive(userId, acca.id, offer.gross)).arrival.delayMs).toBe(
      settings.liveBetDelayMs,
    );
    // over 2.5 is decided in play: the bet's only open leg is prematch, so it cashes out at once.
    await handle.db.transaction((tx) =>
      resultMarket(tx, a!.marketIds.ou, { score: { home: 2, away: 1 } }),
    );
    const decided = await offerOf(userId, acca.id);
    const { arrival, key } = await arrive(userId, acca.id, decided.gross);
    expect(arrival).toMatchObject({ delayMs: 0, liveLegs: [] });
    const result = await cashOut(userId, acca.id, decided.gross, { key, arrival });
    expect(result.bet.status).toBe('cashed_out');
  });

  it('prepareCashOut refuses at once what would be refused anyway, and never delays a replay', async () => {
    const userId = await player();
    const { bet: placed, offer } = await liveSingle(userId);
    // A quoted gross above the offer: the fresh offer, at once.
    expect(await domainError(arrive(userId, placed.id, offer.gross + 1n))).toMatchObject({
      status: 409,
      code: 'cashout_offer_changed',
      details: { offer: { gross: offer.gross.toString() } },
    });
    // Someone else's bet: 404; a non-positive amount: 422.
    expect(await domainError(arrive(await player(), placed.id, offer.gross))).toMatchObject({
      status: 404,
    });
    expect(await domainError(arrive(userId, placed.id, 0n))).toMatchObject({
      status: 422,
      code: 'invalid_amount',
    });
    // Paid once after the delay; the same request again is a replay that waits for nothing.
    const { arrival, key, after } = await arrive(userId, placed.id, offer.gross);
    await cashOut(userId, placed.id, offer.gross, { key, now: after, arrival });
    const replay = await prepareCashOut(handle.db, {
      userId,
      betId: placed.id,
      quotedGross: offer.gross,
      idempotencyKey: key,
      config,
      liveDelayMs: settings.liveBetDelayMs,
      now: new Date(),
    });
    expect(replay).toMatchObject({ delayMs: 0, liveLegs: [] });
    expect(await cashOut(userId, placed.id, offer.gross, { key, arrival: replay })).toMatchObject({
      replayed: true,
    });
    // A suspended market: unavailable at once.
    const other = await liveSingle(userId);
    await suspendMarket(other.event.marketIds['1x2'], 'suspended');
    expect(await domainError(arrive(userId, other.bet.id, other.offer.gross))).toMatchObject({
      status: 409,
      code: 'cashout_unavailable',
      details: { reason: 'leg_suspended' },
    });
  });
});

describe('cash-out and settlement', () => {
  it('cash-out first: a settlement of the same bet waits for it, then leaves the bet alone', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    const offer = await offerOf(userId, placed.id);
    const start = await balances(handle.db, userId);

    const held = heldTransaction((tx) =>
      cashOutBet(tx, {
        userId,
        betId: placed.id,
        quotedGross: offer.gross,
        idempotencyKey: cashOutKey(),
        now: new Date(),
        config,
      }),
    );
    await held.inside;
    // The cash-out holds the bet (settlement's lock) and its event and selection
    // (resulting's locks) until it commits.
    expect(await lockFree('bets', placed.id)).toBe(false);
    expect(await lockFree('events', event.eventId)).toBe(false);
    expect(await lockFree('markets', event.marketIds['1x2'])).toBe(false);
    expect(await lockFree('selections', event.home)).toBe(false);
    const settling = handle.db
      .transaction((tx) => settlePlacedBet(tx, placed.id, new Date()))
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await waitForLockWait();
    held.release();
    await held.done;
    expect(await settling).toMatchObject({ result: { outcome: 'skipped', status: 'cashed_out' } });

    // The match ends and is settled: the cashed-out bet is not touched.
    await finish(handle.db, event.eventId, 1, 0);
    const summary = await handle.db.transaction((tx) =>
      settleEventBets(tx, event.eventId, new Date()),
    );
    expect(summary.bets).toBe(0);
    expect(await postingsOf(placed.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_cashout', 'cashout:ID'],
    ]);
    expect(delta(start, await balances(handle.db, userId))).toEqual({
      cash: offer.net,
      stakes: -birr(100),
      revenue: birr(100) - offer.gross,
      tax: offer.tax,
    });
    await expectBooksBalanced();
  });

  it('a result waits for a cash-out in progress; the bet then stays cashed out', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    const offer = await offerOf(userId, placed.id);
    const held = heldTransaction((tx) =>
      cashOutBet(tx, {
        userId,
        betId: placed.id,
        quotedGross: offer.gross,
        idempotencyKey: cashOutKey(),
        now: new Date(),
        config,
      }),
    );
    await held.inside;
    const resulting = finish(handle.db, event.eventId, 0, 1).then(
      () => 'resulted',
      (error: unknown) => error,
    );
    await waitForLockWait();
    held.release();
    await held.done;
    expect(await resulting).toBe('resulted');
    expect(
      await handle.db.transaction((tx) => settlePlacedBet(tx, placed.id, new Date())),
    ).toMatchObject({ outcome: 'skipped' });
    expect((await bet(placed.id)).status).toBe('cashed_out');
  });

  it('settlement first: a cash-out of the same bet waits for it, then is refused', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    const offer = await offerOf(userId, placed.id);
    const start = await balances(handle.db, userId);
    await finish(handle.db, event.eventId, 3, 1);

    const held = heldTransaction((tx) => settlePlacedBet(tx, placed.id, new Date()));
    expect(await held.inside).toMatchObject({ outcome: 'settled', status: 'won' });
    const cashing = cashOut(userId, placed.id, offer.gross).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    await waitForLockWait();
    held.release();
    await held.done;
    const outcome = await cashing;
    expect(outcome).toMatchObject({
      error: { status: 409, code: 'cashout_unavailable', details: { reason: 'bet_not_open' } },
    });
    expect(await postingsOf(placed.id)).toEqual([
      ['bet_stake', 'bet:…'],
      ['bet_payout', 'settle:ID:0'],
    ]);
    expect((await bet(placed.id)).status).toBe('won');
    // Won at 2.00, 100 ETB of winnings taxed 20%: 180 ETB.
    expect(delta(start, await balances(handle.db, userId)).cash).toBe(birr(180));
    await expectBooksBalanced();
  });

  it('a cashed-out bet is never touched by later results, corrections or the sweep', async () => {
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(100));
    await reprice(handle.db, event.home, 1700);
    const offer = await offerOf(userId, placed.id);
    const cashed = await cashOut(userId, placed.id, offer.gross);
    const snapshot = async () => ({
      bet: betState(await bet(placed.id)),
      postings: await postingsOf(placed.id),
      outbox: (await outboxOf(placed.id)).map((row) => row.type),
      balances: await balances(handle.db, userId),
    });
    const before = await snapshot();
    expect(before.bet).toEqual(betState(cashed.bet));

    for (const [home, away] of [
      [1, 0],
      [0, 1],
      [2, 2],
    ] as const) {
      await finish(handle.db, event.eventId, home, away);
      const summary = await handle.db.transaction((tx) =>
        settleEventBets(tx, event.eventId, new Date()),
      );
      expect(summary.bets).toBe(0);
      expect(
        await handle.db.transaction((tx) => settlePlacedBet(tx, placed.id, new Date())),
      ).toMatchObject({ outcome: 'skipped', status: 'cashed_out' });
    }
    await cancel(handle.db, event.eventId);
    expect(
      await listBetsToSettle(handle.db, new Date(Date.now() + 60_000), {
        graceMs: 0,
        lookbackMs: 3600_000,
        limit: 1000,
      }),
    ).not.toContain(placed.id);
    expect(await snapshot()).toEqual(before);
  });

  it('the database keeps a cashed-out bet final and its record append-only', async () => {
    const userId = await player();
    const { bet: placed } = await single(userId, birr(100));
    const offer = await offerOf(userId, placed.id);
    await cashOut(userId, placed.id, offer.gross);
    const attempt = async (query: string, params: unknown[]) => {
      try {
        await handle.pool.query(query, params);
        return 'ok';
      } catch (error) {
        return pgCode(error);
      }
    };
    expect(
      await attempt(
        `UPDATE bets SET status = 'won', settled_gross_payout = 1, settled_tax = 0, settled_net_payout = 1 WHERE id = $1`,
        [placed.id],
      ),
    ).toBe('23001');
    expect(
      await attempt('UPDATE bets SET settled_net_payout = settled_net_payout + 1 WHERE id = $1', [
        placed.id,
      ]),
    ).toBe('23001');
    expect(
      await attempt('UPDATE bet_cashouts SET net = net + 1 WHERE bet_id = $1', [placed.id]),
    ).toBe('23001');
    expect(await attempt('DELETE FROM bet_cashouts WHERE bet_id = $1', [placed.id])).toBe('23001');
    // Harmless columns may still change.
    expect(await attempt('UPDATE bets SET updated_at = now() WHERE id = $1', [placed.id])).toBe(
      'ok',
    );

    // An open bet cannot be marked cashed out without its record and posting.
    const { bet: open } = await single(userId, birr(100));
    expect(
      await attempt(
        `UPDATE bets SET status = 'cashed_out', settled_gross_payout = 100, settled_tax = 0,
           settled_net_payout = 100, settled_at = now() WHERE id = $1`,
        [open.id],
      ),
    ).toBe('23514');
    // Nor can a bet be inserted cashed out.
    expect(
      await attempt(
        `INSERT INTO bets (user_id, short_id, bet_type, stake, total_odds_milli,
           potential_gross_payout, potential_bonus, potential_tax, potential_net_payout,
           status, odds_change_policy, idempotency_key, terms, placed_at,
           settled_gross_payout, settled_tax, settled_net_payout, settled_at)
         VALUES ($1, 'ZZZZZZZZ', 'single', 100, 2000, 200, 0, 0, 200, 'cashed_out', 'none',
           'raw-insert', '{}'::jsonb, now(), 100, 0, 100, now())`,
        [userId],
      ),
    ).toBe('23514');
    expect((await bet(open.id)).status).toBe('open');
  });
});

describe('wagering', () => {
  it('cashed-out bets do not count toward the deposit wagering requirement', async () => {
    const userId = await player(birr(200));
    expect(await getRemainingWagering(handle.db, userId, 10_000)).toBe(birr(200));
    const { event, bet: placed } = await single(userId, birr(150));
    // An open bet counts.
    expect(await getRemainingWagering(handle.db, userId, 10_000)).toBe(birr(50));
    await reprice(handle.db, event.home, 2000);
    const offer = await offerOf(userId, placed.id);
    await cashOut(userId, placed.id, offer.gross);
    // Deposit, bet, cash out at once: the stake no longer counts.
    expect(await getRemainingWagering(handle.db, userId, 10_000)).toBe(birr(200));
    expect(await loadWageringEvents(handle.db, userId)).toEqual([
      { kind: 'funding', amount: birr(200) },
    ]);
    const { bet: kept } = await single(userId, birr(150));
    expect(await getRemainingWagering(handle.db, userId, 10_000)).toBe(birr(50));
    expect((await bet(kept.id)).status).toBe('open');
  });
});

describe('wire view', () => {
  type Equals<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

  it('matches the @vamos/contracts CashedOutView contract', async () => {
    const sameView: Equals<ReturnType<typeof cashedOutView>, CashedOutViewContract> = true;
    expect(sameView).toBe(true);
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(1_000), { odds: 3000 });
    await reprice(handle.db, event.home, 1200);
    const offer = await offerOf(userId, placed.id);
    const { bet: cashed, cashOut: paid } = await cashOut(userId, placed.id, offer.gross);
    const view = cashedOutView(paid);
    expect(CashedOutViewContract.parse(view)).toEqual(view);
    expect(view).toEqual({
      gross: '237500',
      tax: '27500',
      net: '210000',
      cashedOutAt: paid.cashedOutAt.toISOString(),
    });
    expect(cashed.cashedOut).toEqual(paid);
  });

  it('matches the @vamos/contracts CashOutOfferView contract', async () => {
    const sameView: Equals<ReturnType<typeof cashOutOfferView>, CashOutOfferViewContract> = true;
    const sameReasons: Equals<CashOutUnavailable, ContractReason> = true;
    expect(sameView && sameReasons).toBe(true);
    expect(MAX_CASH_OUT_BATCH).toBe(MAX_CASH_OUT_OFFERS);
    const userId = await player();
    const { event, bet: placed } = await single(userId, birr(1_000), { odds: 3000 });
    await reprice(handle.db, event.home, 1200);
    const available = cashOutOfferView(await offerOf(userId, placed.id));
    expect(CashOutOfferViewContract.parse(available)).toEqual(available);
    expect(available).toMatchObject({ gross: '237500', tax: '27500', net: '210000' });
    await suspendMarket(event.marketIds['1x2'], 'suspended');
    const unavailable = cashOutOfferView(await offerOf(userId, placed.id));
    expect(CashOutOfferViewContract.parse(unavailable)).toEqual(unavailable);
    expect(unavailable).toMatchObject({ available: false, reason: 'leg_suspended', gross: '0' });
  });
});

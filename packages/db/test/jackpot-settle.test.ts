import { randomUUID } from 'node:crypto';
import { birr, type TaxConfig } from '@vamos/core';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getJackpotRound,
  getRemainingWagering,
  getUserJackpotEntry,
  listJackpotRoundIdsForEvent,
  listJackpotRoundIdsForMarket,
  listJackpotRoundsToSettle,
  listRecentJackpotRounds,
  netLossSince,
  settleJackpotRound,
  staffVoidMarket,
  staffVoidSelection,
  type CatalogIds,
} from '../src/index';
import {
  auditLog,
  jackpotEntries,
  jackpotGames,
  jackpotRounds,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  outboxEvents,
} from '../src/schema/index';
import { createBettingDatabase, finish, type TestDb, type TestEvent } from './betting-fixtures';
import {
  cashOf,
  createGames,
  enter,
  entryPostings,
  entryRow,
  HOUR,
  houseBalances,
  openRound,
  resultGame,
  settle,
} from './jackpot-fixtures';
import { createUser, dropTestDatabase, errorText, fund, pgCode } from './helpers';

let handle: TestDb;
let ids: CatalogIds;

beforeAll(async () => {
  ({ handle, ids } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

/** Funding of every player created here (for the reconciliation at the end). */
const funded = new Map<string, bigint>();

async function player(amount = birr(1_000)): Promise<string> {
  const userId = await createUser(handle.db);
  await fund(handle.db, userId, amount);
  funded.set(userId, amount);
  return userId;
}

/**
 * The winnings tax of a jackpot prize written out from the tax rules: the
 * rate on the winnings above the entry's cost (or on the whole prize with
 * the gross base), nothing below the exemption, never above the winnings.
 */
function taxOf(cost: bigint, prize: bigint, config: TaxConfig): bigint {
  const winnings = prize > cost ? prize - cost : 0n;
  const base = config.base === 'net_winnings' ? winnings : prize;
  if (winnings === 0n || base < config.exemptBelow) return 0n;
  const tax = (base * BigInt(config.rateBps)) / 10_000n;
  return tax < winnings ? tax : winnings;
}

const TAX: TaxConfig = { rateBps: 2_000, base: 'net_winnings', exemptBelow: birr(100) };
/** The small template: 3 correct share 1,000 ETB, 2 correct win 20 ETB each. */
const POOL = birr(1_000);
const FIXED = birr(20);

async function round3(): Promise<{ games: TestEvent[]; roundId: string }> {
  const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
  const round = await openRound(handle.db, games, { tax: TAX });
  return { games, roundId: round.id };
}

async function outboxOf(aggregateId: string) {
  return handle.db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, aggregateId))
    .orderBy(outboxEvents.id);
}

describe('settleJackpotRound', () => {
  it('pays shared and fixed tiers from the formulas, taxed above each entry’s cost', async () => {
    const { games, roundId } = await round3();
    const [a, b, c, d] = [await player(), await player(), await player(), await player()];
    const house = await houseBalances(handle.db);
    // Results will be 1, X, 2.
    const entryA = (await enter(handle.db, a, roundId, [['1'], ['X'], ['2']])).entry; // 3 correct
    // (1,X,2) 3 correct + (X,X,2) 2 correct.
    const entryB = (await enter(handle.db, b, roundId, [['1', 'X'], ['X'], ['2']])).entry;
    // (1,X,1) and (1,X,X): 2 correct each.
    const entryC = (await enter(handle.db, c, roundId, [['1'], ['X'], ['1', 'X']])).entry;
    const entryD = (await enter(handle.db, d, roundId, [['2'], ['2'], ['1']])).entry; // none
    for (const [game, result] of [
      [games[0], '1'],
      [games[1], 'X'],
      [games[2], '2'],
    ] as const) {
      await resultGame(handle.db, game!, result);
    }

    const result = await settle(handle.db, roundId);
    expect(result).toMatchObject({ outcome: 'settled', status: 'settled', entries: 4, winners: 3 });

    // 2 combinations with 3 correct share the pool; 3 with 2 correct win the fixed prize.
    const share = POOL / 2n;
    const prizes = { a: share, b: share + FIXED, c: 2n * FIXED, d: 0n };
    const costs = { a: birr(10), b: birr(20), c: birr(20), d: birr(10) };
    const taxes = {
      a: taxOf(costs.a, prizes.a, TAX), // 20% of 490 ETB
      b: taxOf(costs.b, prizes.b, TAX), // 20% of 500 ETB
      c: taxOf(costs.c, prizes.c, TAX), // 20 ETB of winnings: exempt
      d: 0n,
    };
    expect(taxes).toEqual({ a: birr(98), b: birr(100), c: 0n, d: 0n });

    const expected = [
      [entryA.id, 'won', ['0', '0', '0', '1'], 3, prizes.a, taxes.a],
      [entryB.id, 'won', ['0', '0', '1', '1'], 3, prizes.b, taxes.b],
      [entryC.id, 'won', ['0', '0', '2', '0'], 2, prizes.c, taxes.c],
      [entryD.id, 'lost', ['1', '0', '0', '0'], 0, 0n, 0n],
    ] as const;
    for (const [id, status, correct, best, gross, tax] of expected) {
      const row = await entryRow(handle.db, id);
      expect(row).toMatchObject({
        status,
        correct,
        bestCorrect: best,
        prizeGross: gross,
        prizeTax: tax,
        prizeNet: gross - tax,
      });
      expect(row.settledAt).not.toBeNull();
    }
    expect(await cashOf(handle.db, a)).toBe(birr(1_000) - costs.a + prizes.a - taxes.a);
    expect(await cashOf(handle.db, b)).toBe(birr(1_000) - costs.b + prizes.b - taxes.b);
    expect(await cashOf(handle.db, c)).toBe(birr(1_000) - costs.c + prizes.c);
    expect(await cashOf(handle.db, d)).toBe(birr(1_000) - costs.d);
    const stakes = costs.a + costs.b + costs.c + costs.d;
    const paid = prizes.a + prizes.b + prizes.c;
    const after = await houseBalances(handle.db);
    expect(after.jackpot - house.jackpot).toBe(stakes - paid);
    expect(after.tax - house.tax).toBe(taxes.a + taxes.b);

    // The tax is inside the prize posting, so loss limits count what the player received.
    expect(await netLossSince(handle.db, a, new Date(Date.now() - HOUR))).toBe(
      costs.a - (prizes.a - taxes.a),
    );

    const prizeKeys = (await entryPostings(handle.db, entryA.id)).map((p) => [
      p.type,
      p.idempotencyKey,
    ]);
    expect(prizeKeys).toContainEqual(['jackpot_prize', `jackpot_prize:${entryA.id}`]);
    expect(await entryPostings(handle.db, entryD.id)).toHaveLength(1);

    const round = await getJackpotRound(handle.db, roundId);
    expect(round?.games.map((g) => g.result)).toEqual(['1', 'X', '2']);
    expect(round?.settlement).toEqual({
      void: false,
      voidReason: null,
      results: ['1', 'X', '2'],
      cancelledGames: 0,
      entries: 4,
      winners: 3,
      stakes,
      gross: paid,
      tax: taxes.a + taxes.b,
      net: paid - taxes.a - taxes.b,
      refunds: 0n,
      undistributed: 0n,
      payouts: [
        {
          correct: 3,
          kind: 'shared',
          winningCombinations: 2n,
          prizePerCombination: share,
          total: POOL,
          undistributed: 0n,
        },
        {
          correct: 2,
          kind: 'fixed',
          winningCombinations: 3n,
          prizePerCombination: FIXED,
          total: 3n * FIXED,
          undistributed: 0n,
        },
      ],
    });

    const [settledEvent] = await outboxOf(entryB.id).then((rows) =>
      rows.filter((row) => row.type === 'jackpot.settled'),
    );
    expect(settledEvent?.payload).toEqual({
      entryId: entryB.id,
      roundId,
      userId: b,
      templateCode: 'daily9',
      status: 'won',
      cost: costs.b.toString(),
      gross: prizes.b.toString(),
      tax: taxes.b.toString(),
      net: (prizes.b - taxes.b).toString(),
      refund: '0',
      bestCorrect: 3,
    });
    const roundEvents = (await outboxOf(roundId)).map((row) => row.type);
    expect(roundEvents).toEqual([
      'jackpot.round_opened',
      'jackpot.round_closed',
      'jackpot.round_settled',
    ]);
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, roundId), eq(auditLog.action, 'jackpot.round_settled')));
    expect(audit).toMatchObject({ actorType: 'system', targetType: 'jackpot_round' });

    const recent = await listRecentJackpotRounds(handle.db, { limit: 50 });
    expect(recent.items.map((r) => r.id)).toContain(roundId);
    const view = await getUserJackpotEntry(handle.db, b, entryB.id);
    expect(view).toMatchObject({
      status: 'won',
      correct: [0n, 0n, 1n, 1n],
      prizeNet: prizes.b - taxes.b,
      refund: null,
    });
    expect(view?.round.status).toBe('settled');
  });

  it('counts every pick of a cancelled game as correct (all_win) without voiding the round', async () => {
    const { games, roundId } = await round3();
    const [e, f] = [await player(), await player()];
    const entryE = (await enter(handle.db, e, roundId, [['2'], ['1'], ['1']])).entry;
    // Game 1 cancelled: each of the 3 picks is correct; game 3 wrong → 3 combinations at 2.
    const entryF = (await enter(handle.db, f, roundId, [['1', 'X', '2'], ['1'], ['X']])).entry;
    await resultGame(handle.db, games[0]!, 'cancelled');
    await resultGame(handle.db, games[1]!, '1');
    await resultGame(handle.db, games[2]!, '1');

    const result = await settle(handle.db, roundId);
    expect(result).toMatchObject({ outcome: 'settled', winners: 2 });
    const prizeE = POOL; // the only combination with 3 correct
    const prizeF = 3n * FIXED;
    expect(await entryRow(handle.db, entryE.id)).toMatchObject({
      status: 'won',
      bestCorrect: 3,
      prizeGross: prizeE,
      prizeTax: taxOf(birr(10), prizeE, TAX),
    });
    expect(await entryRow(handle.db, entryF.id)).toMatchObject({
      status: 'won',
      correct: ['0', '0', '3', '0'],
      prizeGross: prizeF,
      prizeTax: 0n,
      prizeNet: prizeF,
    });
    const round = await getJackpotRound(handle.db, roundId);
    expect(round?.settlement).toMatchObject({ void: false, cancelledGames: 1 });
    expect(round?.games.map((g) => g.result)).toEqual(['cancelled', '1', '1']);
  });

  it('voids the round and refunds every entry when more than half of the games are cancelled', async () => {
    const { games, roundId } = await round3();
    const [g, h] = [await player(birr(100)), await player(birr(100))];
    const house = await houseBalances(handle.db);
    const entryG = (await enter(handle.db, g, roundId, [['1', 'X'], ['1'], ['1']])).entry;
    const entryH = (await enter(handle.db, h, roundId, [['1'], ['1'], ['1']])).entry;
    expect(await getRemainingWagering(handle.db, g, 10_000)).toBe(birr(80));
    await resultGame(handle.db, games[0]!, 'cancelled');
    await resultGame(handle.db, games[1]!, '1');
    await resultGame(handle.db, games[2]!, 'cancelled');

    const result = await settle(handle.db, roundId);
    expect(result).toMatchObject({
      outcome: 'voided',
      status: 'cancelled',
      entries: 2,
      winners: 0,
    });
    expect(await cashOf(handle.db, g)).toBe(birr(100));
    expect(await cashOf(handle.db, h)).toBe(birr(100));
    expect((await houseBalances(handle.db)).jackpot).toBe(house.jackpot);
    for (const entry of [entryG, entryH]) {
      expect(await entryRow(handle.db, entry.id)).toMatchObject({
        status: 'void',
        correct: null,
        bestCorrect: null,
        prizeGross: 0n,
        prizeTax: 0n,
        prizeNet: 0n,
      });
      const keys = (await entryPostings(handle.db, entry.id)).map((p) => [
        p.type,
        p.idempotencyKey,
      ]);
      expect(keys).toContainEqual(['jackpot_entry', `jackpot_refund:${entry.id}`]);
      expect(keys).toHaveLength(2);
    }
    const view = await getUserJackpotEntry(handle.db, g, entryG.id);
    expect(view).toMatchObject({ status: 'void', refund: birr(20), prizeNet: 0n });
    const round = await getJackpotRound(handle.db, roundId);
    expect(round?.status).toBe('cancelled');
    expect(round?.settlement).toMatchObject({
      void: true,
      voidReason: 'cancelled_games',
      cancelledGames: 2,
      refunds: birr(30),
      stakes: birr(30),
      gross: 0n,
      payouts: [],
    });
    const [voided] = (await outboxOf(entryG.id)).filter((row) => row.type === 'jackpot.settled');
    expect(voided?.payload).toMatchObject({ status: 'void', net: '0', refund: '2000' });
    // A refunded entry no longer counts as wagered, and its loss is gone.
    expect(await getRemainingWagering(handle.db, g, 10_000)).toBe(birr(100));
    expect(await netLossSince(handle.db, g, new Date(Date.now() - HOUR))).toBe(0n);
  });

  it('taxes prizes with the tax terms the round was opened with', async () => {
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
    const grossTax: TaxConfig = { rateBps: 1_000, base: 'gross_payout', exemptBelow: 0n };
    const round = await openRound(handle.db, games, { tax: grossTax });
    const userId = await player();
    const house = await houseBalances(handle.db);
    const { entry } = await enter(handle.db, userId, round.id, [['1'], ['1'], ['1']]);
    for (const game of games) await resultGame(handle.db, game, '1');
    await settle(handle.db, round.id);
    // 10% of the whole 1,000 ETB prize: 100 ETB (below the 990 ETB of winnings).
    const tax = taxOf(birr(10), POOL, grossTax);
    expect(tax).toBe(birr(100));
    expect(await entryRow(handle.db, entry.id)).toMatchObject({
      prizeGross: POOL,
      prizeTax: tax,
      prizeNet: POOL - tax,
    });
    expect((await houseBalances(handle.db)).tax - house.tax).toBe(tax);
    expect(await cashOf(handle.db, userId)).toBe(birr(1_000) - birr(10) + POOL - tax);
  });

  it('keeps the pool with the house when nobody wins it', async () => {
    const { games, roundId } = await round3();
    const [p, q] = [await player(), await player()];
    const house = await houseBalances(handle.db);
    await enter(handle.db, p, roundId, [['2'], ['2'], ['2']]);
    await enter(handle.db, q, roundId, [['1', 'X'], ['X'], ['X']]); // (1,X,X) has 1 correct at most
    for (const game of games) await resultGame(handle.db, game, '1');
    const result = await settle(handle.db, roundId);
    expect(result).toMatchObject({ outcome: 'settled', winners: 0 });
    const after = await houseBalances(handle.db);
    expect(after.jackpot - house.jackpot).toBe(birr(30));
    expect(after.tax).toBe(house.tax);
    const round = await getJackpotRound(handle.db, roundId);
    expect(round?.settlement).toMatchObject({
      winners: 0,
      gross: 0n,
      undistributed: POOL,
      stakes: birr(30),
    });
    expect(round?.settlement?.payouts[0]).toMatchObject({
      winningCombinations: 0n,
      prizePerCombination: 0n,
      total: 0n,
      undistributed: POOL,
    });
  });

  it('rounds a shared prize down and keeps the remainder', async () => {
    const { games, roundId } = await round3();
    const players = [await player(), await player(), await player()];
    for (const userId of players) await enter(handle.db, userId, roundId, [['1'], ['1'], ['1']]);
    for (const game of games) await resultGame(handle.db, game, '1');
    await settle(handle.db, roundId);
    const each = POOL / 3n; // 333.33⅓ ETB → 33,333 santim each, 1 santim left over
    expect(each).toBe(33_333n);
    expect(POOL - 3n * each).toBe(1n);
    const round = await getJackpotRound(handle.db, roundId);
    expect(round?.settlement).toMatchObject({ gross: 3n * each, undistributed: POOL - 3n * each });
    for (const userId of players) {
      expect(await cashOf(handle.db, userId)).toBe(
        birr(1_000) - birr(10) + each - taxOf(birr(10), each, TAX),
      );
    }
  });

  it('waits for every game, then settles once however often it runs', async () => {
    const { games, roundId } = await round3();
    const userId = await player();
    const { entry } = await enter(handle.db, userId, roundId, [['1'], ['1'], ['1']]);
    // Still open: nothing to do.
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'open', status: 'open' });

    await resultGame(handle.db, games[0]!, '1');
    const pending = await settle(handle.db, roundId);
    expect(pending).toMatchObject({ outcome: 'pending', status: 'closed', closed: true });
    // The known result is shown already.
    expect((await getJackpotRound(handle.db, roundId))?.games.map((g) => g.result)).toEqual([
      '1',
      null,
      null,
    ]);
    expect(await listJackpotRoundsToSettle(handle.db, new Date(), { limit: 100 })).toContain(
      roundId,
    );
    await resultGame(handle.db, games[1]!, '1');
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'pending', closed: false });
    await resultGame(handle.db, games[2]!, '1');
    expect(await listJackpotRoundIdsForEvent(handle.db, games[2]!.eventId)).toEqual([roundId]);
    expect(await listJackpotRoundIdsForMarket(handle.db, games[2]!.marketIds['1x2'])).toEqual([
      roundId,
    ]);

    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'settled', winners: 1 });
    const cash = await cashOf(handle.db, userId);
    for (let i = 0; i < 3; i += 1) {
      expect(await settle(handle.db, roundId)).toMatchObject({
        outcome: 'unchanged',
        status: 'settled',
      });
    }
    expect(await cashOf(handle.db, userId)).toBe(cash);
    expect(await entryPostings(handle.db, entry.id)).toHaveLength(2);
    const settledEvents = (await outboxOf(entry.id)).filter((r) => r.type === 'jackpot.settled');
    expect(settledEvents).toHaveLength(1);
    expect(await listJackpotRoundsToSettle(handle.db, new Date(), { limit: 100 })).not.toContain(
      roundId,
    );
  });

  it('pays once when settlements run concurrently', async () => {
    const { games, roundId } = await round3();
    const players = [await player(), await player(), await player(), await player()];
    const entries = [];
    for (const [i, userId] of players.entries()) {
      const picks = i % 2 === 0 ? [['1'], ['1'], ['1']] : [['1'], ['1'], ['X']];
      entries.push((await enter(handle.db, userId, roundId, picks)).entry);
    }
    for (const game of games) await resultGame(handle.db, game, '1');
    const house = await houseBalances(handle.db);

    const results = await Promise.all(Array.from({ length: 6 }, () => settle(handle.db, roundId)));
    expect(results.filter((r) => r.outcome === 'settled')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'unchanged')).toHaveLength(5);
    const [prizes] = await handle.db
      .select({ n: count() })
      .from(ledgerTransactions)
      .where(
        inArray(
          ledgerTransactions.idempotencyKey,
          entries.map((entry) => `jackpot_prize:${entry.id}`),
        ),
      );
    expect(prizes?.n).toBe(4);
    // Two share the pool; two win the fixed prize.
    const share = POOL / 2n;
    const after = await houseBalances(handle.db);
    expect(house.jackpot - after.jackpot).toBe(2n * share + 2n * FIXED);
    expect(after.tax - house.tax).toBe(2n * taxOf(birr(10), share, TAX));
  });

  it('flags a result corrected after settlement and never pays again', async () => {
    const { games, roundId } = await round3();
    const userId = await player();
    const loser = await player();
    await enter(handle.db, userId, roundId, [['1'], ['1'], ['1']]);
    await enter(handle.db, loser, roundId, [['2'], ['1'], ['1']]);
    for (const game of games) await resultGame(handle.db, game, '1');
    await settle(handle.db, roundId);
    const cash = { winner: await cashOf(handle.db, userId), loser: await cashOf(handle.db, loser) };
    const house = await houseBalances(handle.db);

    // Game 1 corrected from a home win to an away win.
    await finish(handle.db, games[0]!.eventId, 0, 1);
    const flagged = await settle(handle.db, roundId);
    expect(flagged).toMatchObject({ outcome: 'flagged', status: 'settled' });
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'unchanged' });

    expect(await cashOf(handle.db, userId)).toBe(cash.winner);
    expect(await cashOf(handle.db, loser)).toBe(cash.loser);
    expect(await houseBalances(handle.db)).toEqual(house);
    const round = await getJackpotRound(handle.db, roundId);
    expect(round?.resultsFlaggedAt).not.toBeNull();
    // The games keep the results the round was settled on.
    expect(round?.games.map((g) => g.result)).toEqual(['1', '1', '1']);
    const mismatches = (await outboxOf(roundId)).filter(
      (row) => row.type === 'jackpot.result_mismatch',
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.payload).toMatchObject({
      roundId,
      games: [{ position: 0, eventId: games[0]!.eventId, settled: '1', current: '2' }],
    });

    // The database refuses to change a settled round's game result or settlement.
    for (const attempt of [
      () =>
        handle.db
          .update(jackpotGames)
          .set({ result: '2' })
          .where(and(eq(jackpotGames.roundId, roundId), eq(jackpotGames.position, 0))),
      () =>
        handle.db
          .update(jackpotRounds)
          .set({ status: 'closed' })
          .where(eq(jackpotRounds.id, roundId)),
    ]) {
      let error: unknown;
      try {
        await attempt();
      } catch (caught) {
        error = caught;
      }
      expect(pgCode(error)).toBe('23001');
    }
    let reopened: unknown;
    try {
      await handle.db
        .update(jackpotEntries)
        .set({
          status: 'open',
          correct: null,
          bestCorrect: null,
          prizeGross: null,
          prizeTax: null,
          prizeNet: null,
          settledAt: null,
        })
        .where(eq(jackpotEntries.userId, userId));
    } catch (caught) {
      reopened = caught;
    }
    expect(errorText(reopened)).toContain('its settlement is final');
  });

  it('flags every new discrepancy after settlement, not only the first one', async () => {
    const { games, roundId } = await round3();
    await enter(handle.db, await player(), roundId, [['1'], ['1'], ['1']]);
    for (const game of games) await resultGame(handle.db, game, '1');
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'settled' });
    const mismatches = async () =>
      (await outboxOf(roundId)).filter((row) => row.type === 'jackpot.result_mismatch');
    const audits = async () =>
      handle.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.targetId, roundId), eq(auditLog.action, 'jackpot.result_mismatch')));

    // Game 1 corrected to an away win: flagged.
    await finish(handle.db, games[0]!.eventId, 0, 1);
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'flagged' });
    const firstFlag = (await getJackpotRound(handle.db, roundId))?.resultsFlaggedAt;
    expect(firstFlag).toBeInstanceOf(Date);
    // Then game 3 corrected to a draw: a second, different discrepancy.
    await finish(handle.db, games[2]!.eventId, 1, 1);
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'flagged' });
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'unchanged' });
    // Then game 1 reverted to the home win the round was settled on.
    await finish(handle.db, games[0]!.eventId, 2, 1);
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'flagged' });
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'unchanged' });

    const rows = await mismatches();
    expect(rows.map((row) => row.payload)).toMatchObject([
      { games: [{ position: 0, settled: '1', current: '2' }] },
      {
        games: [
          { position: 0, settled: '1', current: '2' },
          { position: 2, settled: '1', current: 'X' },
        ],
      },
      { games: [{ position: 2, settled: '1', current: 'X' }] },
    ]);
    expect(await audits()).toHaveLength(3);
    // results_flagged_at keeps the first flag's time.
    expect((await getJackpotRound(handle.db, roundId))?.resultsFlaggedAt).toEqual(firstFlag);
  });

  it('pays a large round in short batches after one decision, so entries elsewhere do not wait', async () => {
    const { games, roundId } = await round3();
    for (let i = 0; i < 25; i += 1) {
      const picks = i % 2 === 0 ? [['1'], ['1'], ['1']] : [['1'], ['1'], ['X']];
      await enter(handle.db, await player(), roundId, picks);
    }
    const other = await round3();
    const late = await player();
    for (const game of games) await resultGame(handle.db, game, '1');
    const house = await houseBalances(handle.db);
    const batch = () =>
      handle.db.transaction((tx) => settleJackpotRound(tx, roundId, new Date(), { batchSize: 10 }));

    // The decision and the first batch; an entry into another round waits for this batch only.
    let entryPlaced: Promise<unknown> | undefined;
    const first = await handle.db.transaction(async (tx) => {
      const run = await settleJackpotRound(tx, roundId, new Date(), { batchSize: 10 });
      entryPlaced = enter(handle.db, late, other.roundId, [['1'], ['1'], ['1']]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return run;
    });
    expect(first).toMatchObject({ outcome: 'settling', status: 'closed', entries: 10 });
    await entryPlaced;
    const open = async () =>
      (
        await handle.db
          .select({ n: count() })
          .from(jackpotEntries)
          .where(and(eq(jackpotEntries.roundId, roundId), eq(jackpotEntries.status, 'open')))
      )[0]?.n;
    expect(await open()).toBe(15);
    expect((await getJackpotRound(handle.db, roundId))?.settlement).toBeNull();

    // A correction while the round is being paid does not change the decided results.
    await finish(handle.db, games[0]!.eventId, 0, 1);
    expect(await batch()).toMatchObject({ outcome: 'settling', entries: 10 });
    expect(await batch()).toMatchObject({ outcome: 'settled', status: 'settled', entries: 5 });
    expect(await open()).toBe(0);
    // Paying the last batch flagged the correction; nothing more to do.
    const round = await getJackpotRound(handle.db, roundId);
    expect(round?.resultsFlaggedAt).not.toBeNull();
    expect(round?.settlement).toMatchObject({ results: ['1', '1', '1'], entries: 25, winners: 25 });
    expect(await batch()).toMatchObject({ outcome: 'unchanged' });

    // 13 share the pool (rounded down), 12 win the fixed prize: each paid exactly once.
    const after = await houseBalances(handle.db);
    // (The entry into the other round paid 10 ETB in.)
    expect(house.jackpot - after.jackpot).toBe((POOL / 13n) * 13n + 12n * FIXED - birr(10));
    const [prizes] = await handle.db
      .select({ n: count() })
      .from(ledgerTransactions)
      .where(
        and(
          eq(ledgerTransactions.type, 'jackpot_prize'),
          inArray(
            ledgerTransactions.refId,
            handle.db
              .select({ id: sql<string>`${jackpotEntries.id}::text` })
              .from(jackpotEntries)
              .where(eq(jackpotEntries.roundId, roundId)),
          ),
        ),
      );
    expect(prizes?.n).toBe(25);
    const roundEvents = (await outboxOf(roundId)).map((row) => row.type);
    expect(roundEvents.filter((type) => type === 'jackpot.round_settled')).toHaveLength(1);
    for (const game of other.games) await resultGame(handle.db, game, '1');
    expect(await settle(handle.db, other.roundId)).toMatchObject({ outcome: 'settled' });
  });

  it('lists a settled round whose result was corrected later for the sweep (lost job)', async () => {
    const { games, roundId } = await round3();
    await enter(handle.db, await player(), roundId, [['1'], ['1'], ['1']]);
    for (const game of games) await resultGame(handle.db, game, '1');
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'settled' });
    const listed = (now = new Date()) => listJackpotRoundsToSettle(handle.db, now, { limit: 100 });
    expect(await listed()).not.toContain(roundId);

    // The correction's event.result_corrected job is lost: the sweep finds the round.
    await finish(handle.db, games[1]!.eventId, 0, 1);
    expect(await listed()).toContain(roundId);
    expect(await settle(handle.db, roundId)).toMatchObject({ outcome: 'flagged' });
    // Only recent rounds are looked at again.
    expect(await listed(new Date(Date.now() + 8 * 24 * HOUR))).not.toContain(roundId);
  });

  it('flags a settled round when staff void an outcome or the market of one of its games', async () => {
    const actor = { adminId: randomUUID() };
    const reason = 'pricing error';
    const listed = () => listJackpotRoundsToSettle(handle.db, new Date(), { limit: 100 });

    // Voiding the winning outcome leaves game 1 without a clean result (1 void, X and 2 lost).
    const one = await round3();
    await enter(handle.db, await player(), one.roundId, [['1'], ['1'], ['1']]);
    for (const game of one.games) await resultGame(handle.db, game, '1');
    expect(await settle(handle.db, one.roundId)).toMatchObject({ outcome: 'settled' });
    await handle.db.transaction((tx) =>
      staffVoidSelection(tx, { selectionId: one.games[0]!.home, reason, actor }),
    );
    // The sweep sees the change even if the market.resulted job is lost.
    expect(await listed()).toContain(one.roundId);
    expect(await settle(handle.db, one.roundId)).toMatchObject({
      outcome: 'flagged',
      status: 'settled',
    });
    expect(await settle(handle.db, one.roundId)).toMatchObject({ outcome: 'unchanged' });
    const [flaggedOne] = await handle.db
      .select({ flagged: jackpotRounds.resultsFlagged })
      .from(jackpotRounds)
      .where(eq(jackpotRounds.id, one.roundId));
    expect(flaggedOne?.flagged).toEqual(['unresolved', null, null]);
    const mismatch = (await outboxOf(one.roundId)).filter(
      (row) => row.type === 'jackpot.result_mismatch',
    );
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.payload).toMatchObject({
      games: [{ position: 0, settled: '1', current: null }],
    });

    // Voiding the whole market of a game cancels it: flagged the same way.
    const two = await round3();
    await enter(handle.db, await player(), two.roundId, [['1'], ['1'], ['1']]);
    for (const game of two.games) await resultGame(handle.db, game, '1');
    expect(await settle(handle.db, two.roundId)).toMatchObject({ outcome: 'settled' });
    await handle.db.transaction((tx) =>
      staffVoidMarket(tx, { marketId: two.games[1]!.marketIds['1x2'], reason, actor }),
    );
    expect(await listed()).toContain(two.roundId);
    expect(await settle(handle.db, two.roundId)).toMatchObject({ outcome: 'flagged' });
    const [flaggedTwo] = await handle.db
      .select({ flagged: jackpotRounds.resultsFlagged })
      .from(jackpotRounds)
      .where(eq(jackpotRounds.id, two.roundId));
    expect(flaggedTwo?.flagged).toEqual([null, 'cancelled', null]);
  });

  it('reconciles house_jackpot, house_tax_payable and every player’s cash with the entries', async () => {
    // Everything this file did: only jackpot activity touched these accounts.
    const rows = await handle.db.select().from(jackpotEntries);
    const settledOpen = rows.filter((row) => row.status === 'open');
    const stakes = rows.reduce((sum, row) => sum + row.cost, 0n);
    const prizes = rows.reduce((sum, row) => sum + (row.prizeGross ?? 0n), 0n);
    const refunds = rows
      .filter((row) => row.status === 'void')
      .reduce((sum, row) => sum + row.cost, 0n);
    const taxes = rows.reduce((sum, row) => sum + (row.prizeTax ?? 0n), 0n);
    expect(settledOpen).toEqual([]);
    const house = await houseBalances(handle.db);
    expect(house.jackpot).toBe(stakes - prizes - refunds);
    expect(house.tax).toBe(taxes);
    for (const [userId, amount] of funded) {
      const own = rows.filter((row) => row.userId === userId);
      const expected =
        amount -
        own.reduce((sum, row) => sum + row.cost, 0n) +
        own.reduce((sum, row) => sum + (row.prizeNet ?? 0n), 0n) +
        own.filter((row) => row.status === 'void').reduce((sum, row) => sum + row.cost, 0n);
      expect(await cashOf(handle.db, userId)).toBe(expected);
    }
    // And the ledger as a whole still balances, with every cached balance matching its entries.
    const [total] = await handle.db
      .select({ sum: sql<string>`COALESCE(SUM(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries);
    expect(total?.sum).toBe('0');
    const mismatched = await handle.db.execute<{ key: string }>(sql`
      SELECT a.key FROM ${ledgerAccounts} a
      WHERE a.balance <> (SELECT COALESCE(SUM(e.amount), 0) FROM ${ledgerEntries} e WHERE e.account_id = a.id)
    `);
    expect(mismatched.rows).toEqual([]);
  });
});

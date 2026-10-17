import { birr } from '@vamos/core';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDueJackpotRounds,
  DomainError,
  getRemainingWagering,
  getUserJackpotEntry,
  listUserJackpotEntries,
  type CatalogIds,
  type JackpotRound,
} from '../src/index';
import {
  auditLog,
  jackpotEntries,
  ledgerTransactions,
  outboxEvents,
  rgExclusions,
  rgLimits,
} from '../src/schema/index';
import { cancel, createBettingDatabase, goLive, type TestDb } from './betting-fixtures';
import {
  cashOf,
  createGames,
  enter,
  entryPostings,
  HOUR,
  houseBalances,
  jackpotKey,
  MINUTE,
  openRound,
  smallTemplate,
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

async function player(amount = birr(1_000)): Promise<string> {
  const userId = await createUser(handle.db);
  if (amount > 0n) await fund(handle.db, userId, amount);
  return userId;
}

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

/** A fresh open round of the small template, its first kick-off an hour from now. */
async function freshRound(options: { maxCombinations?: number } = {}): Promise<JackpotRound> {
  const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
  return openRound(handle.db, games, {
    template: smallTemplate(
      options.maxCombinations === undefined ? {} : { maxCombinations: options.maxCombinations },
    ),
  });
}

async function entriesOf(userId: string): Promise<number> {
  const [row] = await handle.db
    .select({ n: count() })
    .from(jackpotEntries)
    .where(eq(jackpotEntries.userId, userId));
  return row?.n ?? 0;
}

describe('placeJackpotEntry', () => {
  it('prices an entry per combination and pays it from the player into house_jackpot', async () => {
    const round = await freshRound();
    const userId = await player();
    const house = await houseBalances(handle.db);
    const key = jackpotKey();
    const now = new Date();
    // 2 × 1 × 3 = 6 combinations at 10 ETB; picks out of order are stored in 1, X, 2 order.
    const { entry, replayed } = await enter(
      handle.db,
      userId,
      round.id,
      [['X', '1'], ['2'], ['2', '1', 'X']],
      { key, now },
    );
    expect(replayed).toBe(false);
    expect(entry).toMatchObject({
      userId,
      roundId: round.id,
      status: 'open',
      channel: 'web',
      picks: [['1', 'X'], ['2'], ['1', 'X', '2']],
      combinations: 6,
      cost: birr(60),
      correct: null,
      bestCorrect: null,
      prizeGross: null,
      prizeTax: null,
      prizeNet: null,
      refund: null,
      placedAt: now,
      settledAt: null,
    });
    expect(entry.round).toMatchObject({ id: round.id, status: 'open', gameCount: 3 });
    expect(entry.round.games).toHaveLength(3);

    expect(await cashOf(handle.db, userId)).toBe(birr(940));
    expect((await houseBalances(handle.db)).jackpot).toBe(house.jackpot + birr(60));
    const [posting] = await handle.db
      .select()
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `jackpot_entry:${userId}:${key}`));
    expect(posting).toMatchObject({
      type: 'jackpot_entry',
      refType: 'jackpot_entry',
      refId: entry.id,
      actorType: 'user',
      actorId: userId,
    });
    const outbox = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, entry.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'jackpot.entered',
      aggregateType: 'jackpot_entry',
      payload: {
        entryId: entry.id,
        roundId: round.id,
        userId,
        templateCode: 'daily9',
        combinations: 6,
        cost: '6000',
        channel: 'web',
      },
    });
    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.targetId, entry.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'jackpot.entered',
      actorType: 'user',
      actorId: userId,
    });
    expect(await getUserJackpotEntry(handle.db, userId, entry.id)).toEqual(entry);
  });

  it('refuses invalid picks with 422 jackpot_entry_invalid and writes nothing', async () => {
    const round = await freshRound();
    const userId = await player();
    const cases: Array<{ picks: unknown; errors: string[]; combinations: number | null }> = [
      {
        picks: [['1'], ['X']],
        errors: ['Expected picks for 3 games but got 2.'],
        combinations: 1,
      },
      {
        picks: [[], ['1'], ['X']],
        errors: ['Game 1: pick at least one outcome.'],
        combinations: 0,
      },
      {
        picks: [['1'], ['3'], ['X', 'X']],
        errors: [
          'Game 2: "3" is not a valid pick (use 1, X or 2).',
          'Game 3: "X" is picked more than once.',
        ],
        combinations: 2,
      },
      {
        // 3 × 3 × 3 = 27 combinations; this round allows 8.
        picks: [
          ['1', 'X', '2'],
          ['1', 'X', '2'],
          ['1', 'X', '2'],
        ],
        errors: ['Too many combinations: 27 (the maximum is 8).'],
        combinations: 27,
      },
    ];
    for (const { picks, errors, combinations } of cases) {
      const error = await domainError(enter(handle.db, userId, round.id, picks as string[][]));
      expect(error).toMatchObject({ status: 422, code: 'jackpot_entry_invalid' });
      expect(error.details).toEqual({ errors, gameCount: 3, combinations, maxCombinations: 8 });
    }
    const malformed = await domainError(
      enter(handle.db, userId, round.id, 'not picks' as unknown as string[][]),
    );
    expect(malformed).toMatchObject({ status: 422, code: 'jackpot_entry_invalid' });
    const nested = await domainError(
      enter(handle.db, userId, round.id, [['1'], [1], ['X']] as unknown as string[][]),
    );
    expect(nested).toMatchObject({ status: 422, code: 'jackpot_entry_invalid' });

    expect(await cashOf(handle.db, userId)).toBe(birr(1_000));
    expect(await entriesOf(userId)).toBe(0);
  });

  it('accepts exactly the maximum number of combinations', async () => {
    const round = await freshRound();
    const userId = await player();
    const { entry } = await enter(handle.db, userId, round.id, [
      ['1', 'X'],
      ['1', 'X'],
      ['1', '2'],
    ]);
    expect(entry).toMatchObject({ combinations: 8, cost: birr(80) });
  });

  it('404 for an unknown or malformed round', async () => {
    const userId = await player();
    for (const roundId of ['00000000-0000-4000-8000-000000000000', 'nope']) {
      const error = await domainError(enter(handle.db, userId, roundId, [['1'], ['1'], ['1']]));
      expect(error).toMatchObject({ status: 404, code: 'not_found' });
    }
  });

  describe('responsible gambling', () => {
    it('refuses an entry above the per-bet stake limit (the cost is the stake)', async () => {
      const round = await freshRound();
      const userId = await player();
      const now = new Date();
      await handle.db.insert(rgLimits).values({
        userId,
        kind: 'stake',
        period: 'bet',
        amount: birr(50),
        effectiveFrom: now,
        createdAt: now,
      });
      // 6 combinations = 60 ETB > 50 ETB.
      const error = await domainError(
        enter(handle.db, userId, round.id, [['1', 'X'], ['2'], ['1', 'X', '2']], { now }),
      );
      expect(error).toMatchObject({ status: 422, code: 'stake_limit_exceeded' });
      expect(error.details).toEqual({ period: 'bet', limit: '5000', stake: '6000' });
      // One combination (10 ETB) is within the limit.
      const { entry } = await enter(handle.db, userId, round.id, [['1'], ['1'], ['1']], { now });
      expect(entry.cost).toBe(birr(10));
      expect(await cashOf(handle.db, userId)).toBe(birr(990));
    });

    it('counts open entries as losses for the loss limit', async () => {
      const round = await freshRound();
      const userId = await player();
      const now = new Date();
      await handle.db.insert(rgLimits).values({
        userId,
        kind: 'loss',
        period: 'day',
        amount: birr(50),
        effectiveFrom: now,
        createdAt: now,
      });
      await enter(handle.db, userId, round.id, [['1', 'X'], ['2'], ['1', 'X']], { now });
      const error = await domainError(
        enter(handle.db, userId, round.id, [['1'], ['X'], ['2', '1']], { now }),
      );
      expect(error).toMatchObject({ status: 422, code: 'loss_limit_exceeded' });
      expect(await cashOf(handle.db, userId)).toBe(birr(960));
    });

    it('refuses a self-excluded player with 403 before anything is paid', async () => {
      const round = await freshRound();
      const userId = await player();
      const now = new Date();
      await handle.db
        .insert(rgExclusions)
        .values({ userId, kind: 'self_exclusion', startsAt: now, endsAt: null });
      const error = await domainError(
        enter(handle.db, userId, round.id, [['1'], ['1'], ['1']], { now }),
      );
      expect(error).toMatchObject({ status: 403, code: 'self_excluded' });
      expect(await cashOf(handle.db, userId)).toBe(birr(1_000));
      expect(await entriesOf(userId)).toBe(0);
    });
  });

  describe('closed rounds', () => {
    it('refuses entries once the round is closed or its closing time has come', async () => {
      const start = new Date(Date.now() + HOUR);
      const games = await createGames(handle.db, ids, 3, start);
      const round = await openRound(handle.db, games);
      expect(round.closesAt).toEqual(start);
      const userId = await player();

      // At the closing time, before the worker closed it: refused.
      const atClose = await domainError(
        enter(handle.db, userId, round.id, [['1'], ['1'], ['1']], { now: start }),
      );
      expect(atClose).toMatchObject({ status: 409, code: 'jackpot_closed' });
      expect(atClose.details).toEqual({ reason: 'closed', status: 'open' });

      const closed = await handle.db.transaction((tx) => closeDueJackpotRounds(tx, start));
      expect(closed.closed).toContain(round.id);
      const before = new Date(start.getTime() - MINUTE);
      const afterClose = await domainError(
        enter(handle.db, userId, round.id, [['1'], ['1'], ['1']], { now: before }),
      );
      expect(afterClose).toMatchObject({ status: 409, code: 'jackpot_closed' });
      expect(afterClose.details).toEqual({ reason: 'closed', status: 'closed' });
      expect(await cashOf(handle.db, userId)).toBe(birr(1_000));
    });

    it('refuses entries when a game kicked off, went live or was cancelled early', async () => {
      const userId = await player();
      // A game went live before the round's closing time: refused.
      const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
      const round = await openRound(handle.db, games);
      await goLive(handle.db, games[2]!.eventId);
      const live = await domainError(enter(handle.db, userId, round.id, [['1'], ['1'], ['1']]));
      expect(live).toMatchObject({ status: 409, code: 'jackpot_closed' });
      expect(live.details).toEqual({ reason: 'game_started', status: 'open' });

      const others = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
      const second = await openRound(handle.db, others);
      await cancel(handle.db, others[1]!.eventId);
      const cancelled = await domainError(
        enter(handle.db, userId, second.id, [['1'], ['1'], ['1']]),
      );
      expect(cancelled.details).toEqual({ reason: 'game_started', status: 'open' });
      expect(await cashOf(handle.db, userId)).toBe(birr(1_000));
    });

    it('refuses entries into a scheduled round (409 not_open)', async () => {
      const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
      const round = await openRound(handle.db, games, { status: 'scheduled' });
      const userId = await player();
      const error = await domainError(enter(handle.db, userId, round.id, [['1'], ['1'], ['1']]));
      expect(error).toMatchObject({ status: 409, code: 'jackpot_closed' });
      expect(error.details).toEqual({ reason: 'not_open', status: 'scheduled' });
    });
  });

  describe('idempotency', () => {
    it('replays the same entry for the same key and picks, without paying twice', async () => {
      const round = await freshRound();
      const userId = await player();
      const key = jackpotKey();
      const first = await enter(handle.db, userId, round.id, [['1', 'X'], ['2'], ['1']], { key });
      // The same picks in another order are the same request.
      const again = await enter(handle.db, userId, round.id, [['X', '1'], ['2'], ['1']], { key });
      expect(again.replayed).toBe(true);
      expect(again.entry).toEqual(first.entry);
      expect(await cashOf(handle.db, userId)).toBe(birr(980));
      expect(await entryPostings(handle.db, first.entry.id)).toHaveLength(1);
      const [outbox] = await handle.db
        .select({ n: count() })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, first.entry.id));
      expect(outbox?.n).toBe(1);
      const [audit] = await handle.db
        .select({ n: count() })
        .from(auditLog)
        .where(eq(auditLog.targetId, first.entry.id));
      expect(audit?.n).toBe(1);
    });

    it('422 idempotency_key_reused for other picks or another round', async () => {
      const round = await freshRound();
      const other = await freshRound();
      const userId = await player();
      const key = jackpotKey();
      await enter(handle.db, userId, round.id, [['1'], ['2'], ['1']], { key });
      for (const [roundId, picks] of [
        [round.id, [['1'], ['2'], ['X']]],
        [other.id, [['1'], ['2'], ['1']]],
      ] as const) {
        const error = await domainError(enter(handle.db, userId, roundId, picks, { key }));
        expect(error).toMatchObject({ status: 422, code: 'idempotency_key_reused' });
      }
      expect(await cashOf(handle.db, userId)).toBe(birr(990));
    });

    it('replays an entry even after its round has closed', async () => {
      const start = new Date(Date.now() + HOUR);
      const games = await createGames(handle.db, ids, 3, start);
      const round = await openRound(handle.db, games);
      const userId = await player();
      const key = jackpotKey();
      const first = await enter(handle.db, userId, round.id, [['1'], ['2'], ['1']], { key });
      await handle.db.transaction((tx) => closeDueJackpotRounds(tx, start));
      const replay = await enter(handle.db, userId, round.id, [['1'], ['2'], ['1']], {
        key,
        now: new Date(start.getTime() + MINUTE),
      });
      expect(replay.replayed).toBe(true);
      expect(replay.entry.id).toBe(first.entry.id);
      expect(replay.entry.round.status).toBe('closed');
    });

    it('concurrent requests with one key place one entry', async () => {
      const round = await freshRound();
      const userId = await player();
      const key = jackpotKey();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          enter(handle.db, userId, round.id, [['1'], ['X'], ['2']], { key }),
        ),
      );
      expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await cashOf(handle.db, userId)).toBe(birr(990));
    });
  });

  describe('funds', () => {
    it('422 insufficient_funds when the balance does not cover the cost', async () => {
      const round = await freshRound();
      const userId = await player(birr(50));
      const error = await domainError(
        enter(handle.db, userId, round.id, [['1', 'X'], ['2'], ['1', 'X', '2']]),
      );
      expect(error).toMatchObject({ status: 422, code: 'insufficient_funds' });
      expect(error.details).toEqual({ balance: '5000', cost: '6000' });
      expect(await cashOf(handle.db, userId)).toBe(birr(50));
      expect(await entriesOf(userId)).toBe(0);
    });

    it('20 concurrent entries never overdraw the balance', async () => {
      const round = await freshRound();
      const userId = await player(birr(100));
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => enter(handle.db, userId, round.id, [['1'], ['X'], ['2']])),
      );
      const placed = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(placed).toHaveLength(10);
      for (const r of refused) {
        expect((r.reason as DomainError).code).toBe('insufficient_funds');
      }
      expect(await cashOf(handle.db, userId)).toBe(0n);
      const [n] = await handle.db
        .select({ n: count() })
        .from(jackpotEntries)
        .where(and(eq(jackpotEntries.userId, userId), eq(jackpotEntries.roundId, round.id)));
      expect(n?.n).toBe(10);
    });
  });

  describe('wagering', () => {
    it('counts an open entry as wagered turnover', async () => {
      const round = await freshRound();
      const userId = await player(birr(100));
      expect(await getRemainingWagering(handle.db, userId, 10_000)).toBe(birr(100));
      await enter(handle.db, userId, round.id, [['1', 'X'], ['2'], ['1', 'X', '2']]);
      expect(await getRemainingWagering(handle.db, userId, 10_000)).toBe(birr(40));
    });
  });

  describe('my entries', () => {
    it('lists the player’s entries newest first with a cursor', async () => {
      const round = await freshRound();
      const userId = await player();
      const base = Date.now();
      const placed: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const { entry } = await enter(handle.db, userId, round.id, [['1'], ['X'], ['2']], {
          now: new Date(base + i * 1000),
        });
        placed.push(entry.id);
      }
      const first = await listUserJackpotEntries(handle.db, { userId, limit: 2 });
      expect(first.items.map((e) => e.id)).toEqual([placed[2], placed[1]]);
      expect(first.nextCursor).not.toBeNull();
      const second = await listUserJackpotEntries(handle.db, {
        userId,
        limit: 2,
        cursor: first.nextCursor ?? '',
      });
      expect(second.items.map((e) => e.id)).toEqual([placed[0]]);
      expect(second.nextCursor).toBeNull();
      const settled = await listUserJackpotEntries(handle.db, {
        userId,
        status: 'settled',
        limit: 5,
      });
      expect(settled.items).toEqual([]);
      const someoneElse = await player();
      expect(await getUserJackpotEntry(handle.db, someoneElse, placed[0]!)).toBeNull();
      await expect(
        listUserJackpotEntries(handle.db, { userId, limit: 2, cursor: 'garbage' }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    });
  });

  describe('database guards', () => {
    it('refuses an entry row without its payment, and any change to its picks or cost', async () => {
      const round = await freshRound();
      const userId = await player();
      let error: unknown;
      try {
        await handle.db.insert(jackpotEntries).values({
          roundId: round.id,
          userId,
          picks: [['1'], ['X'], ['2']],
          combinations: 1,
          cost: birr(10),
          idempotencyKey: jackpotKey(),
          placedAt: new Date(),
        });
      } catch (caught) {
        error = caught;
      }
      expect(pgCode(error)).toBe('23514');
      expect(errorText(error)).toContain('has no payment of its cost');

      const { entry } = await enter(handle.db, userId, round.id, [['1'], ['X'], ['2']]);
      for (const change of [
        { cost: birr(1) },
        { picks: [['1', 'X'], ['X'], ['2']] as Array<Array<'1' | 'X' | '2'>> },
        { userId: await player() },
      ]) {
        let failed: unknown;
        try {
          await handle.db.update(jackpotEntries).set(change).where(eq(jackpotEntries.id, entry.id));
        } catch (caught) {
          failed = caught;
        }
        expect(pgCode(failed)).toBe('23001');
      }
      let deleted: unknown;
      try {
        await handle.db.delete(jackpotEntries).where(eq(jackpotEntries.id, entry.id));
      } catch (caught) {
        deleted = caught;
      }
      expect(pgCode(deleted)).toBe('23001');
      // An open entry cannot be marked won without its prize posting.
      let unpaid: unknown;
      try {
        await handle.db
          .update(jackpotEntries)
          .set({
            status: 'lost',
            correct: ['1', '0', '0', '0'],
            bestCorrect: 0,
            prizeGross: 0n,
            prizeTax: 0n,
            prizeNet: 0n,
            settledAt: new Date(),
          })
          .where(eq(jackpotEntries.id, entry.id));
      } catch (caught) {
        unpaid = caught;
      }
      // The round is still open: an entry only settles while its round is closed.
      expect(errorText(unpaid)).toContain('settles only while its round is closed');
    });
  });
});

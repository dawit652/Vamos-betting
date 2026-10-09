import { birr } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptPendingBet,
  getBalance,
  getBetById,
  listDuePendingBets,
  rejectPendingBet,
  setMarketStatus,
  settleEventBets,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import { ledgerTransactions, outboxEvents } from '../src/schema/index';
import {
  createBettingDatabase,
  createEvent,
  finish,
  goLive,
  place,
  reprice,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { cash, createUser, dropTestDatabase, fund } from './helpers';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const DELAY = 6_000;

async function player(): Promise<string> {
  const userId = await createUser(handle.db);
  await fund(handle.db, userId, birr(1_000));
  return userId;
}

async function liveEvent(odds?: Parameters<typeof createEvent>[2]): Promise<TestEvent> {
  const event = await createEvent(handle.db, ids, odds);
  await goLive(handle.db, event.eventId);
  return event;
}

const accept = (betId: string, now: Date) =>
  handle.db.transaction((tx) => acceptPendingBet(tx, betId, now));

async function outboxTypes(betId: string): Promise<string[]> {
  const rows = await handle.db
    .select({ type: outboxEvents.type })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateId, betId))
    .orderBy(outboxEvents.id);
  return rows.map((row) => row.type);
}

describe('live bets: delayed acceptance', () => {
  it('a bet with a live leg waits, then is accepted when nothing moved', async () => {
    expect(settings.liveBetDelayMs).toBe(DELAY);
    const live = await liveEvent();
    const prematch = await createEvent(handle.db, ids);
    const userId = await player();
    const now = new Date();
    const { bet } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: live.home, oddsMilli: 2000 },
        { selectionId: prematch.over, oddsMilli: 1900 },
      ],
      settings,
      now,
    });
    expect(bet).toMatchObject({
      status: 'pending_acceptance',
      acceptAfter: new Date(now.getTime() + DELAY),
      acceptedAt: null,
    });
    expect(bet.legs.map((leg) => leg.isLive)).toEqual([true, false]);
    // The stake is held while the bet waits.
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(900));

    expect(await listDuePendingBets(handle.db, now)).not.toContain(bet.id);
    const early = await accept(bet.id, new Date(now.getTime() + DELAY - 1));
    expect(early.outcome).toBe('not_due');
    expect(early.bet.status).toBe('pending_acceptance');

    const due = new Date(now.getTime() + DELAY);
    expect(await listDuePendingBets(handle.db, due)).toContain(bet.id);
    const accepted = await accept(bet.id, due);
    expect(accepted).toMatchObject({
      outcome: 'accepted',
      bet: { status: 'open', acceptedAt: due },
    });
    expect(await outboxTypes(bet.id)).toEqual(['bet.placed', 'bet.accepted']);

    // Idempotent.
    expect((await accept(bet.id, due)).outcome).toBe('unchanged');
    expect(await outboxTypes(bet.id)).toEqual(['bet.placed', 'bet.accepted']);
    expect(await listDuePendingBets(handle.db, due)).not.toContain(bet.id);
  });

  it('rejected and refunded when the odds moved against an odds-policy of none', async () => {
    const live = await liveEvent();
    const userId = await player();
    const now = new Date();
    const { bet } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      settings,
      now,
    });
    await reprice(handle.db, live.home, 1800);
    const due = new Date(now.getTime() + DELAY);
    const result = await accept(bet.id, due);
    expect(result).toMatchObject({
      outcome: 'rejected',
      reason: 'odds_changed',
      bet: { status: 'rejected', rejectReason: 'odds_changed' },
    });
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(1_000));
    const [refund] = await handle.db
      .select({ type: ledgerTransactions.type })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `reject:${bet.id}`));
    expect(refund?.type).toBe('bet_refund');
    expect(await outboxTypes(bet.id)).toEqual(['bet.placed', 'bet.rejected']);

    // Replays refund nothing more.
    expect((await accept(bet.id, due)).outcome).toBe('unchanged');
    expect(
      (await handle.db.transaction((tx) => rejectPendingBet(tx, bet.id, due, 'odds_changed')))
        .outcome,
    ).toBe('unchanged');
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(1_000));
  });

  it('rejected when a live market was suspended during the delay', async () => {
    const live = await liveEvent();
    const userId = await player();
    const now = new Date();
    const { bet } = await place(handle.db, userId, {
      stake: birr(50),
      legs: [{ selectionId: live.over, oddsMilli: 1900 }],
      settings,
      now,
    });
    await handle.db.transaction((tx) => setMarketStatus(tx, live.marketIds.ou, 'suspended'));
    const result = await accept(bet.id, new Date(now.getTime() + DELAY));
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'selection_unavailable' });
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(1_000));
  });

  it('higher: a higher live price is taken at acceptance and the bet re-quoted', async () => {
    const live = await liveEvent();
    const userId = await player();
    const now = new Date();
    const { bet } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      policy: 'higher',
      settings,
      now,
    });
    await reprice(handle.db, live.home, 2500);
    const result = await accept(bet.id, new Date(now.getTime() + DELAY));
    expect(result.outcome).toBe('accepted');
    // 250 gross, 150 winnings → 30 tax.
    expect(result.bet).toMatchObject({
      status: 'open',
      totalOddsMilli: 2500n,
      potentialGrossPayout: birr(250),
      potentialTax: birr(30),
      potentialNetPayout: birr(220),
    });
    expect(result.bet.legs[0]).toMatchObject({ oddsMilli: 2500, requestedOddsMilli: 2000 });
  });

  it('any: a lower live price is taken; higher: it is rejected', async () => {
    const live = await liveEvent();
    const now = new Date();
    const anyBet = await place(handle.db, await player(), {
      stake: birr(100),
      legs: [{ selectionId: live.away, oddsMilli: 3500 }],
      policy: 'any',
      settings,
      now,
    });
    const higherBet = await place(handle.db, await player(), {
      stake: birr(100),
      legs: [{ selectionId: live.away, oddsMilli: 3500 }],
      policy: 'higher',
      settings,
      now,
    });
    await reprice(handle.db, live.away, 3000);
    const due = new Date(now.getTime() + DELAY);
    const any = await accept(anyBet.bet.id, due);
    expect(any).toMatchObject({ outcome: 'accepted', bet: { totalOddsMilli: 3000n } });
    expect(any.bet.potentialGrossPayout).toBe(birr(300));
    expect((await accept(higherBet.bet.id, due)).reason).toBe('odds_changed');
  });

  it('a pending bet is not settled; if its event is resulted first it is rejected and refunded', async () => {
    const live = await liveEvent();
    const userId = await player();
    const now = new Date();
    const { bet } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      settings,
      now,
    });
    await finish(handle.db, live.eventId, 1, 0);
    const summary = await handle.db.transaction((tx) =>
      settleEventBets(tx, live.eventId, new Date()),
    );
    expect(summary).toMatchObject({ bets: 0, pendingAcceptance: 1 });
    expect((await getBetById(handle.db, bet.id))?.status).toBe('pending_acceptance');

    const result = await accept(bet.id, new Date(now.getTime() + DELAY));
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'selection_unavailable' });
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(1_000));
  });

  it('a prematch leg resulted while the bet waited is settled on acceptance', async () => {
    const now = new Date();
    const live = await liveEvent();
    // Kick-off an hour after placement: placement at `now` never races the wall clock.
    const prematch = await createEvent(handle.db, ids, {
      startTime: new Date(now.getTime() + 3600_000),
    });
    const userId = await player();
    const { bet } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: live.home, oddsMilli: 2000 },
        { selectionId: prematch.away, oddsMilli: 3500 },
      ],
      settings,
      now,
    });
    // The prematch event kicks off and is resulted (away lost) within the delay.
    await goLive(handle.db, prematch.eventId);
    await finish(handle.db, prematch.eventId, 3, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, prematch.eventId, new Date()));
    const result = await accept(bet.id, new Date(now.getTime() + DELAY));
    expect(result.outcome).toBe('accepted');
    expect(result.bet.status).toBe('lost');
    expect(result.bet.legs.map((leg) => leg.state)).toEqual(['open', 'lost']);
    expect(await outboxTypes(bet.id)).toEqual(['bet.placed', 'bet.accepted', 'bet.settled']);
  });

  it('acceptance locks the prematch legs too, so resulting them waits for it', async () => {
    const now = new Date();
    const live = await liveEvent();
    const prematch = await createEvent(handle.db, ids, {
      startTime: new Date(now.getTime() + 3600_000),
    });
    const userId = await player();
    const { bet } = await place(handle.db, userId, {
      stake: birr(100),
      legs: [
        { selectionId: live.home, oddsMilli: 2000 },
        { selectionId: prematch.away, oddsMilli: 3500 },
      ],
      settings,
      now,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let accepted!: () => void;
    const inside = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const acceptance = handle.db.transaction(async (tx) => {
      const result = await acceptPendingBet(tx, bet.id, new Date(now.getTime() + DELAY));
      accepted();
      await held;
      return result;
    });
    await inside;
    const client = await handle.pool.connect();
    try {
      // resultEvent locks the event's selections FOR UPDATE: it must wait.
      await expect(
        client.query('SELECT id FROM selections WHERE id = $1 FOR UPDATE NOWAIT', [prematch.away]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      client.release();
      release();
    }
    expect((await acceptance).outcome).toBe('accepted');
    // Resulted after the acceptance committed: the bet is open, so settlement sees it.
    await finish(handle.db, prematch.eventId, 3, 0);
    const summary = await handle.db.transaction((tx) =>
      settleEventBets(tx, prematch.eventId, new Date()),
    );
    expect(summary).toMatchObject({ bets: 1, outcomes: { settled: 1 } });
    expect((await getBetById(handle.db, bet.id))?.status).toBe('lost');
  });
});

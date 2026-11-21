import { birr, toWire, type RiskLimits } from '@vamos/core';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptPendingBet,
  DomainError,
  getBalance,
  loadGameSettings,
  openLiabilities,
  setSetting,
  settleEventBets,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import { betLegs, bets, events, ledgerTransactions } from '../src/schema/index';
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

/**
 * Rule L1: the house liability caps. A cap is checked when a bet is placed (and when a live bet is
 * accepted at a better price), against the open bets summed under a lock per match.
 */

let handle: TestDb;
let ids: CatalogIds;
let defaults: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings: defaults } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const NONE: RiskLimits = { maxSelectionLiability: null, maxEventLiability: null };

/** The settings a caller loaded, with these caps (the caps of the bet being placed). */
const caps = (limits: Partial<RiskLimits>): GameSettings => ({
  ...defaults,
  riskLimits: { ...NONE, ...limits },
});

async function player(amount = birr(10_000)): Promise<string> {
  const userId = await createUser(handle.db);
  await fund(handle.db, userId, amount);
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

/** A single at 2.000 (the default home price): its potential gross payout is twice the stake. */
const home = (event: TestEvent, stake: bigint, settings: GameSettings, userId: string) =>
  place(handle.db, userId, {
    stake,
    legs: [{ selectionId: event.home, oddsMilli: 2000 }],
    settings,
  });

const openBetsOn = async (selectionId: string): Promise<number> => {
  const [row] = await handle.db
    .select({ n: count() })
    .from(betLegs)
    .innerJoin(bets, eq(bets.id, betLegs.betId))
    .where(
      and(
        eq(betLegs.selectionId, selectionId),
        inArray(bets.status, ['open', 'pending_acceptance']),
      ),
    );
  return row?.n ?? 0;
};

const liabilityOf = async (event: TestEvent, selectionId = event.home) => {
  const open = await handle.db.transaction((tx) =>
    openLiabilities(tx, { selectionIds: [selectionId], eventIds: [event.eventId] }),
  );
  return { selection: open.selections[0]!.current, event: open.events[0]!.current };
};

describe('selection cap', () => {
  it('refuses a bet that would pass the cap and names the largest stake that fits', async () => {
    const event = await createEvent(handle.db, ids);
    const s = caps({ maxSelectionLiability: birr(1_000) });
    await home(event, birr(300), s, await player()); // pays 600
    const late = await player();
    const error = await domainError(home(event, birr(300), s, late)); // 600 + 600 > 1 000
    expect(error).toMatchObject({ status: 422, code: 'liability_limit' });
    // 400 of room at 2.000 odds: a stake of 200 pays exactly 400.
    expect(error.details).toEqual({ maxStake: toWire(birr(200)) });
    expect(error.message).toContain('200');

    // The refusal wrote nothing: no bet, no stake posting, the balance is whole.
    expect(await openBetsOn(event.home)).toBe(1);
    expect(await getBalance(handle.db, cash(late))).toBe(birr(10_000));
    const postings = await handle.db
      .select({ n: count() })
      .from(ledgerTransactions)
      .where(sql`${ledgerTransactions.idempotencyKey} LIKE ${`%${late}%`}`);
    expect(postings[0]?.n).toBe(0);

    // The stake it named fits to the last santim; after it nothing fits, not even the minimum.
    await home(event, birr(200), s, late);
    expect((await liabilityOf(event)).selection).toBe(birr(1_000));
    const full = await domainError(home(event, birr(5), s, await player()));
    expect(full.code).toBe('liability_limit');
    expect(full.details).toEqual({ maxStake: null });
    expect(await openBetsOn(event.home)).toBe(2);
  });

  it('keeps the caps private: only the stake that fits is in the error', async () => {
    const event = await createEvent(handle.db, ids);
    const s = caps({ maxSelectionLiability: birr(777) });
    await home(event, birr(300), s, await player());
    const error = await domainError(home(event, birr(300), s, await player()));
    expect(Object.keys(error.details as object)).toEqual(['maxStake']);
    // Neither the cap (777) nor the liability already open (600) is in the message or the body.
    const body = JSON.stringify(error.toBody());
    expect(body).not.toContain('777');
    expect(body).not.toContain('600');
    expect(body).not.toContain('60000');
  });

  it('counts every open bet on the selection, whoever placed it', async () => {
    const event = await createEvent(handle.db, ids);
    const s = caps({ maxSelectionLiability: birr(1_000) });
    for (let i = 0; i < 5; i += 1) await home(event, birr(100), s, await player()); // 5 × 200
    const error = await domainError(home(event, birr(5), s, await player()));
    expect(error.code).toBe('liability_limit');
  });

  it('does not touch another selection of the same match', async () => {
    const event = await createEvent(handle.db, ids);
    const s = caps({ maxSelectionLiability: birr(1_000) });
    await home(event, birr(500), s, await player()); // fills the home selection
    await place(handle.db, await player(), {
      stake: birr(500),
      legs: [{ selectionId: event.away, oddsMilli: 3500 }], // pays 1 750 > 1 000
      settings: s,
    }).then(
      () => {
        throw new Error('expected the away bet to be refused');
      },
      (error: unknown) => expect((error as DomainError).code).toBe('liability_limit'),
    );
    const draw = await place(handle.db, await player(), {
      stake: birr(100),
      legs: [{ selectionId: event.draw, oddsMilli: 3200 }], // pays 320
      settings: s,
    });
    expect(draw.bet.status).toBe('open');
  });
});

describe('match cap', () => {
  it('adds up every market of the match', async () => {
    const event = await createEvent(handle.db, ids);
    const s = caps({ maxEventLiability: birr(1_000) });
    await home(event, birr(250), s, await player()); // 500
    await place(handle.db, await player(), {
      stake: birr(250),
      legs: [{ selectionId: event.over, oddsMilli: 1900 }], // 475
      settings: s,
    });
    expect((await liabilityOf(event, event.over)).event).toBe(birr(975));
    const error = await domainError(
      place(handle.db, await player(), {
        stake: birr(10),
        legs: [{ selectionId: event.draw, oddsMilli: 3200 }], // 32 > 25 left
        settings: s,
      }),
    );
    expect(error).toMatchObject({ code: 'liability_limit' });
    // 25 left at 3.200: a stake of 7.81 fits, offered as 7.
    expect(error.details).toEqual({ maxStake: toWire(birr(7)) });
  });

  it('counts an accumulator once on each match it touches, at its whole payout', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => createEvent(handle.db, ids)));
    const s = caps({ maxEventLiability: birr(1_000) });
    await place(handle.db, await player(), {
      stake: birr(100),
      legs: [
        { selectionId: a!.home, oddsMilli: 2000 },
        { selectionId: b!.home, oddsMilli: 2000 },
      ],
      settings: s,
    }); // pays 400 on a and on b
    expect((await liabilityOf(a!)).event).toBe(birr(400));
    expect((await liabilityOf(b!)).event).toBe(birr(400));
    await home(a!, birr(300), s, await player()); // a: 400 + 600 = 1 000, exactly the cap
    const over = await domainError(
      place(handle.db, await player(), {
        stake: birr(5),
        legs: [{ selectionId: a!.draw, oddsMilli: 3200 }],
        settings: s,
      }),
    );
    expect(over.code).toBe('liability_limit');
    // b still has room.
    await place(handle.db, await player(), {
      stake: birr(5),
      legs: [{ selectionId: b!.away, oddsMilli: 3500 }],
      settings: s,
    });
  });

  it('refuses an accumulator if any one of its matches is full', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => createEvent(handle.db, ids)));
    const s = caps({ maxEventLiability: birr(1_000) });
    await home(a!, birr(500), s, await player()); // a is full
    const error = await domainError(
      place(handle.db, await player(), {
        stake: birr(5),
        legs: [
          { selectionId: b!.home, oddsMilli: 2000 },
          { selectionId: a!.away, oddsMilli: 3500 },
        ],
        settings: s,
      }),
    );
    expect(error.code).toBe('liability_limit');
    expect((await liabilityOf(b!)).event).toBe(0n);
  });
});

describe('releasing liability', () => {
  it('frees the room when a bet is lost', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => createEvent(handle.db, ids)));
    const s = caps({ maxEventLiability: birr(1_000) });
    const { bet } = await place(handle.db, await player(), {
      stake: birr(200),
      legs: [
        { selectionId: a!.home, oddsMilli: 2000 },
        { selectionId: b!.home, oddsMilli: 2000 },
      ],
      settings: s,
    }); // pays 800 on b
    const blocked = await domainError(home(b!, birr(300), s, await player())); // 800 + 600
    expect(blocked.code).toBe('liability_limit');

    // The away side wins match a: the accumulator is lost, its payout no longer counts.
    await finish(handle.db, a!.eventId, 0, 1);
    await handle.db.transaction((tx) => settleEventBets(tx, a!.eventId, new Date()));
    const [row] = await handle.db.select().from(bets).where(eq(bets.id, bet.id));
    expect(row?.status).toBe('lost');
    expect((await liabilityOf(b!)).event).toBe(0n);
    await home(b!, birr(300), s, await player());
  });

  it('frees the room when a pending live bet is rejected', async () => {
    const live = await createEvent(handle.db, ids);
    await goLive(handle.db, live.eventId);
    const s = caps({ maxSelectionLiability: birr(1_000) });
    const now = new Date();
    const first = await place(handle.db, await player(), {
      stake: birr(400),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      settings: s,
      now,
    });
    expect(first.bet.status).toBe('pending_acceptance'); // a pending bet counts
    const blocked = await domainError(
      place(handle.db, await player(), {
        stake: birr(300),
        legs: [{ selectionId: live.home, oddsMilli: 2000 }],
        settings: s,
        now,
      }),
    );
    expect(blocked.code).toBe('liability_limit');

    // The price moves and the bet takes no new price: it is rejected and refunded.
    await reprice(handle.db, live.home, 1800);
    const due = new Date(now.getTime() + defaults.liveBetDelayMs);
    const result = await handle.db.transaction((tx) => acceptPendingBet(tx, first.bet.id, due));
    expect(result.outcome).toBe('rejected');
    expect((await liabilityOf(live)).selection).toBe(0n);
    await place(handle.db, await player(), {
      stake: birr(300),
      legs: [{ selectionId: live.home, oddsMilli: 1800 }],
      settings: s,
      now: due,
    });
  });
});

describe('a cap that changes', () => {
  it('leaves open bets alone and refuses new ones once a cap is below what is open', async () => {
    const event = await createEvent(handle.db, ids);
    const generous = caps({ maxSelectionLiability: birr(1_000) });
    const { bet } = await home(event, birr(400), generous, await player()); // 800
    const tight = caps({ maxSelectionLiability: birr(500) });
    const error = await domainError(home(event, birr(5), tight, await player()));
    expect(error).toMatchObject({ code: 'liability_limit', details: { maxStake: null } });
    const [row] = await handle.db.select().from(bets).where(eq(bets.id, bet.id));
    expect(row?.status).toBe('open');
    // No cap at all: anything goes, as before.
    await home(event, birr(1_000), caps({}), await player());
  });

  it('a replay of a bet already placed is returned even when the cap is full', async () => {
    const event = await createEvent(handle.db, ids);
    const s = caps({ maxSelectionLiability: birr(1_000) });
    const userId = await player();
    const key = `risk-replay-${Date.now()}`;
    const options = {
      stake: birr(500),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings: s,
      key,
    };
    const first = await place(handle.db, userId, options); // fills the cap exactly
    const replay = await place(handle.db, userId, options);
    expect(replay.replayed).toBe(true);
    expect(replay.bet.id).toBe(first.bet.id);
    expect(await openBetsOn(event.home)).toBe(1);
  });
});

describe('concurrent bets', () => {
  it('never pass a selection cap, however many arrive at once', async () => {
    const event = await createEvent(handle.db, ids);
    const s = caps({ maxSelectionLiability: birr(1_000) });
    const users = await Promise.all(Array.from({ length: 20 }, () => player()));
    const results = await Promise.allSettled(users.map((u) => home(event, birr(100), s, u)));
    const placed = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(placed).toHaveLength(5); // 5 × 200 = 1 000
    for (const r of refused) expect((r.reason as DomainError).code).toBe('liability_limit');
    expect((await liabilityOf(event)).selection).toBe(birr(1_000));
    expect(await openBetsOn(event.home)).toBe(5);
  }, 60_000);

  it('never pass a match cap, and accumulators on the same matches in opposite orders do not deadlock', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => createEvent(handle.db, ids)));
    const s = caps({ maxEventLiability: birr(1_000) });
    const users = await Promise.all(Array.from({ length: 16 }, () => player()));
    const results = await Promise.allSettled(
      users.map((userId, i) =>
        place(handle.db, userId, {
          stake: birr(100),
          legs:
            i % 2 === 0
              ? [
                  { selectionId: a!.home, oddsMilli: 2000 },
                  { selectionId: b!.home, oddsMilli: 2000 },
                ]
              : [
                  { selectionId: b!.draw, oddsMilli: 3200 },
                  { selectionId: a!.draw, oddsMilli: 3200 },
                ],
          settings: s,
        }),
      ),
    );
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as DomainError).code).toBe('liability_limit');
    }
    // 4.0 × 100 = 400 and 10.24 × 100 = 1 024: only the first kind can fit (twice), and not the second.
    const la = (await liabilityOf(a!)).event;
    const lb = (await liabilityOf(b!)).event;
    expect(la).toBeLessThanOrEqual(birr(1_000));
    expect(lb).toBeLessThanOrEqual(birr(1_000));
    expect(la).toBe(lb); // every bet touches both matches
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  }, 60_000);
});

describe('live bets accepted at a better price', () => {
  afterEach(async () => {
    await handle.db.transaction((tx) => setSetting(tx, 'risk_limits', NONE, 'test'));
  });

  const store = (limits: Partial<RiskLimits>) =>
    handle.db.transaction((tx) => setSetting(tx, 'risk_limits', { ...NONE, ...limits }, 'test'));

  it('is refused when the higher payout no longer fits, and refunded', async () => {
    const live = await createEvent(handle.db, ids);
    await goLive(handle.db, live.eventId);
    await store({ maxSelectionLiability: birr(1_000) });
    const s = await loadGameSettings(handle.db);
    const userId = await player();
    const now = new Date();
    const { bet } = await place(handle.db, userId, {
      stake: birr(400),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      policy: 'higher',
      settings: s,
      now,
    }); // pays 800: 200 of room left
    await reprice(handle.db, live.home, 3000); // would pay 1 200: 400 more
    const result = await handle.db.transaction((tx) =>
      acceptPendingBet(tx, bet.id, new Date(now.getTime() + defaults.liveBetDelayMs)),
    );
    expect(result).toMatchObject({
      outcome: 'rejected',
      reason: 'odds_changed',
      bet: { status: 'rejected' },
    });
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(10_000));
    expect((await liabilityOf(live)).selection).toBe(0n);
  });

  it('is accepted when the higher payout still fits, and counts at the new payout', async () => {
    const live = await createEvent(handle.db, ids);
    await goLive(handle.db, live.eventId);
    await store({ maxSelectionLiability: birr(1_000) });
    const s = await loadGameSettings(handle.db);
    const now = new Date();
    const { bet } = await place(handle.db, await player(), {
      stake: birr(400),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      policy: 'higher',
      settings: s,
      now,
    });
    await reprice(handle.db, live.home, 2200); // pays 880: 80 more, 200 of room
    const result = await handle.db.transaction((tx) =>
      acceptPendingBet(tx, bet.id, new Date(now.getTime() + defaults.liveBetDelayMs)),
    );
    expect(result.outcome).toBe('accepted');
    expect((await liabilityOf(live)).selection).toBe(birr(880));
  });

  it('reads only the caps: a broken unrelated setting does not stop acceptance', async () => {
    const live = await createEvent(handle.db, ids);
    await goLive(handle.db, live.eventId);
    await store({ maxSelectionLiability: birr(10_000) });
    const now = new Date();
    const { bet } = await place(handle.db, await player(), {
      stake: birr(100),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      policy: 'higher',
      settings: await loadGameSettings(handle.db),
      now,
    });
    await reprice(handle.db, live.home, 2500);
    await handle.db.transaction((tx) => setSetting(tx, 'tax', { rateBps: 'broken' }, 'test'));
    try {
      const result = await handle.db.transaction((tx) =>
        acceptPendingBet(tx, bet.id, new Date(now.getTime() + defaults.liveBetDelayMs)),
      );
      expect(result.outcome).toBe('accepted');
    } finally {
      await handle.db.transaction((tx) => setSetting(tx, 'tax', defaults.tax, 'test'));
    }
  });

  it('is unaffected when no cap is set', async () => {
    const live = await createEvent(handle.db, ids);
    await goLive(handle.db, live.eventId);
    const now = new Date();
    const { bet } = await place(handle.db, await player(), {
      stake: birr(400),
      legs: [{ selectionId: live.home, oddsMilli: 2000 }],
      policy: 'higher',
      settings: await loadGameSettings(handle.db),
      now,
    });
    await reprice(handle.db, live.home, 6000);
    const result = await handle.db.transaction((tx) =>
      acceptPendingBet(tx, bet.id, new Date(now.getTime() + defaults.liveBetDelayMs)),
    );
    expect(result.outcome).toBe('accepted');
  });
});

/**
 * The board caps (settings `board_risk_limits`, docs/plans/narobet-events.md decision D4): a
 * competitor board's own match (feed provider `hulusport` or `narobet`) pays out at most ETB 20,000
 * by default, on top of the plain caps. Staff change or clear it in the back office.
 */
describe('board caps', () => {
  afterEach(async () => {
    await handle.db.transaction(async (tx) => {
      await setSetting(tx, 'risk_limits', NONE, 'test');
      await setSetting(
        tx,
        'board_risk_limits',
        { maxSelectionLiability: null, maxEventLiability: birr(20_000) },
        'test',
      );
    });
  });

  /** A match of a board's own (Hulusport's or Narobet's). */
  async function boardEvent(provider: 'hulusport' | 'narobet' = 'narobet'): Promise<TestEvent> {
    const event = await createEvent(handle.db, ids);
    await handle.db
      .update(events)
      .set({ feedProvider: provider })
      .where(eq(events.id, event.eventId));
    return event;
  }

  it('caps a board match at ETB 20,000 by default, and no other match', async () => {
    const s = await loadGameSettings(handle.db);
    expect(s.boardRiskLimits).toEqual({
      maxSelectionLiability: null,
      maxEventLiability: birr(20_000),
    });
    const board = await boardEvent();
    const error = await domainError(home(board, birr(10_001), s, await player(birr(30_000))));
    // 20 002 > 20 000: the largest stake that fits at 2.000 is 10 000.
    expect(error).toMatchObject({ status: 422, code: 'liability_limit' });
    expect(error.details).toEqual({ maxStake: toWire(birr(10_000)) });
    await home(board, birr(10_000), s, await player(birr(30_000)));
    expect((await liabilityOf(board)).event).toBe(birr(20_000));

    // Our own match has no cap (risk_limits is empty).
    const ours = await createEvent(handle.db, ids);
    await home(ours, birr(15_000), s, await player(birr(30_000)));
    expect((await liabilityOf(ours)).event).toBe(birr(30_000));
  });

  it('counts every open bet on the match, on Hulusport matches as on Narobet ones', async () => {
    const s = await loadGameSettings(handle.db);
    const board = await boardEvent('hulusport');
    await home(board, birr(6_000), s, await player(birr(30_000))); // pays 12 000
    const error = await domainError(home(board, birr(6_000), s, await player(birr(30_000))));
    expect(error.code).toBe('liability_limit');
    expect(error.details).toEqual({ maxStake: toWire(birr(4_000)) });
  });

  it('counts an accumulator in full on its board match', async () => {
    const s = await loadGameSettings(handle.db);
    const board = await boardEvent();
    const ours = await createEvent(handle.db, ids);
    const error = await domainError(
      place(handle.db, await player(birr(30_000)), {
        stake: birr(6_000), // 2.000 x 2.000: pays 24 000
        legs: [
          { selectionId: board.home, oddsMilli: 2000 },
          { selectionId: ours.home, oddsMilli: 2000 },
        ],
        settings: s,
      }),
    );
    expect(error.code).toBe('liability_limit');
    expect((await liabilityOf(board)).event).toBe(0n);
  });

  it('takes the stricter of the plain and the board cap', async () => {
    await handle.db.transaction((tx) =>
      setSetting(tx, 'risk_limits', { ...NONE, maxEventLiability: birr(5_000) }, 'test'),
    );
    const s = await loadGameSettings(handle.db);
    const board = await boardEvent();
    const error = await domainError(home(board, birr(3_000), s, await player()));
    expect(error.details).toEqual({ maxStake: toWire(birr(2_500)) });
  });

  it('follows the setting: staff raise it, or clear it', async () => {
    const board = await boardEvent();
    await handle.db.transaction((tx) =>
      setSetting(
        tx,
        'board_risk_limits',
        { maxSelectionLiability: null, maxEventLiability: birr(50_000) },
        'test',
      ),
    );
    const raised = await loadGameSettings(handle.db);
    await home(board, birr(20_000), raised, await player(birr(30_000))); // pays 40 000
    await handle.db.transaction((tx) =>
      setSetting(
        tx,
        'board_risk_limits',
        { maxSelectionLiability: null, maxEventLiability: null },
        'test',
      ),
    );
    const cleared = await loadGameSettings(handle.db);
    await home(board, birr(25_000), cleared, await player(birr(30_000))); // 90 000 open, no cap
    expect((await liabilityOf(board)).event).toBe(birr(90_000));
  });

  it('applies to a live bet accepted at a better price', async () => {
    const board = await boardEvent();
    await goLive(handle.db, board.eventId);
    const s = await loadGameSettings(handle.db);
    const userId = await player(birr(30_000));
    const now = new Date();
    const { bet } = await place(handle.db, userId, {
      stake: birr(9_000),
      legs: [{ selectionId: board.home, oddsMilli: 2000 }],
      policy: 'higher',
      settings: s,
      now,
    }); // pays 18 000: 2 000 of room left
    await reprice(handle.db, board.home, 2500); // would pay 22 500
    const result = await handle.db.transaction((tx) =>
      acceptPendingBet(tx, bet.id, new Date(now.getTime() + defaults.liveBetDelayMs)),
    );
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'odds_changed' });
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(30_000));
  });
});

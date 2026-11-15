import { birr } from '@vamos/core';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  getBalance,
  quoteSlip,
  upsertFixture,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import { events, markets } from '../src/schema/index';
import { createBettingDatabase, createEvent, place, type TestDb } from './betting-fixtures';
import { cash, createUser, dropTestDatabase, fund } from './helpers';

/**
 * Rule P7, price expiry (docs/plans/hulusport-parity-plan.md 4.5, task 1.10): a market whose
 * `price_valid_until` has passed takes no bet, with no job running; a market without one never
 * expires; `upsertFixture` stamps and refreshes the expiry only when asked.
 */

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function player(): Promise<string> {
  const userId = await createUser(handle.db);
  await fund(handle.db, userId, birr(1_000));
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

async function expireAt(marketId: string, until: Date | null): Promise<void> {
  await handle.db.update(markets).set({ priceValidUntil: until }).where(eq(markets.id, marketId));
}

describe('price expiry at bet placement (P7)', () => {
  it('takes a bet before the expiry and refuses it from the expiry on, without taking the stake', async () => {
    const event = await createEvent(handle.db, ids);
    const now = new Date();
    await expireAt(event.marketIds['1x2'], new Date(now.getTime() + 60_000));
    const userId = await player();

    const placed = await place(handle.db, userId, {
      stake: birr(10),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
      now,
    });
    expect(placed.bet.status).toBe('open');

    const atExpiry = new Date(now.getTime() + 60_000);
    const error = await domainError(
      place(handle.db, userId, {
        stake: birr(10),
        legs: [
          { selectionId: event.home, oddsMilli: 2000 },
          { selectionId: event.over, oddsMilli: 1900 },
        ],
        settings,
        now: atExpiry,
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'selection_unavailable' });
    // Only the expired market's leg is refused; the over/under has no expiry.
    expect(error.details).toEqual({
      selections: [{ selectionId: event.home, reason: 'suspended' }],
    });
    expect(await getBalance(handle.db, cash(userId))).toBe(birr(990));
  });

  it('never expires a market without price_valid_until', async () => {
    const event = await createEvent(handle.db, ids);
    await expireAt(event.marketIds['1x2'], null);
    const userId = await player();
    const placed = await place(handle.db, userId, {
      stake: birr(5),
      legs: [{ selectionId: event.home, oddsMilli: 2000 }],
      settings,
      now: new Date(),
    });
    expect(placed.bet.status).toBe('open');
  });

  it('shows an expired price as unavailable in a slip quote', async () => {
    const event = await createEvent(handle.db, ids);
    const now = new Date();
    await expireAt(event.marketIds.dnb, new Date(now.getTime() - 1));
    const quote = await quoteSlip(handle.db, {
      legs: [{ selectionId: event.dnbHome }, { selectionId: event.home }],
      stake: birr(10),
      settings,
      now,
    });
    expect(quote.legs.map((leg) => [leg.selectionId, leg.available, leg.reason])).toEqual([
      [event.dnbHome, false, 'suspended'],
      [event.home, true, null],
    ]);
  });
});

describe('upsertFixture and price_valid_until', () => {
  async function fixtureMarkets(eventId: string) {
    return handle.db
      .select({ key: markets.key, until: markets.priceValidUntil })
      .from(markets)
      .where(eq(markets.eventId, eventId));
  }

  const fixture = (feedRef: string) => {
    const [home, away] = [...ids.teams.entries()].filter(([key]) => key.startsWith('football/'));
    const competition = [...ids.competitions.entries()].find(([key]) =>
      key.startsWith('football/'),
    );
    if (home === undefined || away === undefined || competition === undefined) {
      throw new Error('no seeded football teams or competition');
    }
    return {
      feedProvider: 'test-expiry',
      feedRef,
      sport: 'football' as const,
      competitionId: competition[1],
      homeTeamId: home[1],
      awayTeamId: away[1],
      startTime: new Date(Date.now() + 6 * 3_600_000),
    };
  };
  const oneXTwo = (home: number) => ({
    type: '1x2' as const,
    line: null,
    selections: [
      { code: '1', oddsMilli: home },
      { code: 'X', oddsMilli: 3300 },
      { code: '2', oddsMilli: 3600 },
    ],
  });
  const btts = {
    type: 'btts' as const,
    line: null,
    selections: [
      { code: 'yes', oddsMilli: 1800 },
      { code: 'no', oddsMilli: 1950 },
    ],
  };

  it('leaves the expiry unset when not asked (the default: nothing changes)', async () => {
    const result = await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture('no-expiry'), [oneXTwo(2100)]),
    );
    expect((await fixtureMarkets(result.eventId)).map((m) => m.until)).toEqual([null]);
  });

  it('stamps new markets, refreshes passed markets (moved or not) and leaves the others', async () => {
    const first = new Date(Date.now() + 30 * 60_000);
    const created = await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture('with-expiry'), [oneXTwo(2100), btts], {
        priceValidUntil: first,
      }),
    );
    for (const market of await fixtureMarkets(created.eventId)) {
      expect(market.until?.getTime()).toBe(first.getTime());
    }

    // A later read passes only the 1x2, at the same price: it is confirmed, btts is not.
    const second = new Date(first.getTime() + 60_000);
    await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture('with-expiry'), [oneXTwo(2100)], { priceValidUntil: second }),
    );
    const byKey = new Map((await fixtureMarkets(created.eventId)).map((m) => [m.key, m.until]));
    expect(byKey.get('1x2')?.getTime()).toBe(second.getTime());
    expect(byKey.get('btts')?.getTime()).toBe(first.getTime());

    // A read without the option does not touch it.
    await handle.db.transaction((tx) => upsertFixture(tx, fixture('with-expiry'), [oneXTwo(2200)]));
    const after = new Map((await fixtureMarkets(created.eventId)).map((m) => [m.key, m.until]));
    expect(after.get('1x2')?.getTime()).toBe(second.getTime());
  });

  it('does not refresh a closed market', async () => {
    const until = new Date(Date.now() + 30 * 60_000);
    const created = await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture('closed-market'), [oneXTwo(2100)], { priceValidUntil: until }),
    );
    await handle.db
      .update(markets)
      .set({ status: 'closed' })
      .where(inArray(markets.eventId, [created.eventId]));
    await handle.db.transaction((tx) =>
      upsertFixture(tx, fixture('closed-market'), [oneXTwo(2100)], {
        priceValidUntil: new Date(until.getTime() + 60_000),
      }),
    );
    const [market] = await fixtureMarkets(created.eventId);
    expect(market?.until?.getTime()).toBe(until.getTime());
    // The event itself is untouched by the expiry.
    const [event] = await handle.db
      .select({ status: events.status })
      .from(events)
      .where(eq(events.id, created.eventId));
    expect(event?.status).toBe('scheduled');
  });
});

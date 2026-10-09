import { randomBytes, randomUUID } from 'node:crypto';
import { BOOKING_CODE_LENGTH, birr, isValidCode } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOKING_CODE_TTL_MS,
  createBookingCode,
  decodeBetCursor,
  DomainError,
  encodeBetCursor,
  getUserBet,
  listUserBets,
  loadBookingCode,
  setMarketStatus,
  settleEventBets,
  type CatalogIds,
  type GameSettings,
} from '../src/index';
import {
  createBettingDatabase,
  createEvent,
  finish,
  place,
  reprice,
  type TestDb,
  type TestEvent,
} from './betting-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';

let handle: TestDb;
let ids: CatalogIds;
let settings: GameSettings;
let a: TestEvent;
let b: TestEvent;

beforeAll(async () => {
  ({ handle, ids, settings } = await createBettingDatabase());
  a = await createEvent(handle.db, ids);
  b = await createEvent(handle.db, ids);
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

const create = (
  legs: Array<{ selectionId: string }>,
  options: { now?: Date; userId?: string } = {},
) =>
  createBookingCode(handle.db, {
    legs,
    now: options.now ?? new Date(),
    userId: options.userId ?? null,
    randomBytes: (n) => randomBytes(n),
  });

describe('booking codes', () => {
  it('creates a 6-symbol code and loads it with current odds', async () => {
    const userId = await createUser(handle.db);
    const now = new Date();
    const booked = await create([{ selectionId: a.home }, { selectionId: b.over }], {
      now,
      userId,
    });
    expect(booked.code).toHaveLength(BOOKING_CODE_LENGTH);
    expect(isValidCode(booked.code, BOOKING_CODE_LENGTH)).toBe(true);
    expect(booked.expiresAt).toEqual(new Date(now.getTime() + BOOKING_CODE_TTL_MS));

    await reprice(handle.db, b.over, 2050);
    // Typed in lower case with a dash, as shared in a chat.
    const typed = `${booked.code.slice(0, 3).toLowerCase()}-${booked.code.slice(3).toLowerCase()}`;
    const loaded = await loadBookingCode(handle.db, typed, new Date());
    expect(loaded.code).toBe(booked.code);
    expect(
      loaded.legs.map((leg) => [leg.selectionId, leg.available, leg.currentOddsMilli]),
    ).toEqual([
      [a.home, true, 2000],
      [b.over, true, 2050],
    ]);
    expect(loaded.legs[0]?.selection?.homeTeam.en).toBe('Arsenal');
  });

  it('shows legs that became unavailable after booking', async () => {
    const own = await createEvent(handle.db, ids);
    const booked = await create([{ selectionId: own.over }]);
    await handle.db.transaction((tx) => setMarketStatus(tx, own.marketIds.ou, 'suspended'));
    const loaded = await loadBookingCode(handle.db, booked.code, new Date());
    expect(loaded.legs[0]).toMatchObject({ available: false, reason: 'suspended' });
  });

  it('404 for unknown or malformed codes, 410 once expired', async () => {
    for (const code of ['ZZZZZZ', 'abc', '', 'O0O0O0']) {
      expect(await domainError(loadBookingCode(handle.db, code, new Date()))).toMatchObject({
        status: 404,
        code: 'booking_code_not_found',
      });
    }
    const now = new Date();
    const booked = await create([{ selectionId: a.draw }], { now });
    const expired = await domainError(
      loadBookingCode(handle.db, booked.code, new Date(now.getTime() + BOOKING_CODE_TTL_MS)),
    );
    expect(expired).toMatchObject({ status: 410, code: 'booking_code_expired' });
  });

  it('refuses unavailable selections and malformed slips', async () => {
    const unknown = randomUUID();
    expect(await domainError(create([{ selectionId: unknown }]))).toMatchObject({
      status: 409,
      code: 'selection_unavailable',
      details: { selections: [{ selectionId: unknown, reason: 'not_found' }] },
    });
    for (const [legs, code] of [
      [[], 'no_selections'],
      [[{ selectionId: a.home }, { selectionId: a.home }], 'duplicate_selection'],
      [[{ selectionId: a.home }, { selectionId: a.over }], 'duplicate_event'],
    ] as const) {
      const error = await domainError(create([...legs]));
      expect(error).toMatchObject({ status: 422, code: 'slip_invalid' });
      expect((error.details as { errors: Array<{ code: string }> }).errors[0]?.code).toBe(code);
    }
  });

  it('draws another code on a collision', async () => {
    const fixed = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const first = await createBookingCode(handle.db, {
      legs: [{ selectionId: b.home }],
      now: new Date(),
      randomBytes: () => fixed,
    });
    let calls = 0;
    const second = await createBookingCode(handle.db, {
      legs: [{ selectionId: b.home }],
      now: new Date(),
      randomBytes: (n) => {
        calls += 1;
        return calls === 1 ? fixed : randomBytes(n);
      },
    });
    expect(calls).toBe(2);
    expect(second.code).not.toBe(first.code);
  });
});

describe('my bets', () => {
  it('lists open and settled bets newest first with a cursor', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(1_000));
    const own = await createEvent(handle.db, ids);
    const base = Date.now();
    const placed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { bet } = await place(handle.db, userId, {
        stake: birr(10),
        legs: [{ selectionId: own.home, oddsMilli: 2000 }],
        settings,
        now: new Date(base + i * 1000),
      });
      placed.push(bet.id);
    }
    const lost = await place(handle.db, userId, {
      stake: birr(10),
      legs: [{ selectionId: a.away, oddsMilli: 3500 }],
      settings,
      now: new Date(base + 5000),
    });

    const page1 = await listUserBets(handle.db, { userId, status: 'open', limit: 2 });
    expect(page1.items.map((bet) => bet.id)).toEqual([lost.bet.id, placed[2]]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listUserBets(handle.db, {
      userId,
      status: 'open',
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((bet) => bet.id)).toEqual([placed[1], placed[0]]);
    expect(page2.nextCursor).toBeNull();
    expect(page2.items[0]?.legs[0]?.selection).toMatchObject({
      code: '1',
      marketType: '1x2',
      homeTeam: { en: 'Arsenal' },
    });

    expect((await listUserBets(handle.db, { userId, status: 'settled', limit: 10 })).items).toEqual(
      [],
    );
    await finish(handle.db, a.eventId, 2, 0);
    await handle.db.transaction((tx) => settleEventBets(tx, a.eventId, new Date()));
    const settled = await listUserBets(handle.db, { userId, status: 'settled', limit: 10 });
    expect(settled.items.map((bet) => [bet.id, bet.status])).toEqual([[lost.bet.id, 'lost']]);
    expect(
      (await listUserBets(handle.db, { userId, status: 'open', limit: 10 })).items,
    ).toHaveLength(3);
  });

  it('getUserBet returns only the player’s own bet', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(100));
    const { bet } = await place(handle.db, userId, {
      stake: birr(10),
      legs: [{ selectionId: b.draw, oddsMilli: 3200 }],
      settings,
    });
    expect((await getUserBet(handle.db, userId, bet.id))?.id).toBe(bet.id);
    expect(await getUserBet(handle.db, await createUser(handle.db), bet.id)).toBeNull();
    expect(await getUserBet(handle.db, userId, 'not-a-uuid')).toBeNull();
  });

  it('cursors round-trip and junk is 400 invalid_cursor', async () => {
    const cursor = { placedAt: new Date(1_791_500_000_123), id: randomUUID() };
    expect(decodeBetCursor(encodeBetCursor(cursor))).toEqual(cursor);
    for (const junk of ['', 'abc', Buffer.from('1.x').toString('base64url')]) {
      expect(() => decodeBetCursor(junk)).toThrow(DomainError);
    }
    // The last millisecond of year 9999 is the latest cursor time.
    const latest = { placedAt: new Date('9999-12-31T23:59:59.999Z'), id: randomUUID() };
    expect(decodeBetCursor(encodeBetCursor(latest))).toEqual(latest);
    const userId0 = await createUser(handle.db);
    await expect(
      listUserBets(handle.db, {
        userId: userId0,
        status: 'settled',
        limit: 5,
        cursor: encodeBetCursor(latest),
      }),
    ).resolves.toMatchObject({ items: [] });
    // Later times are valid JS dates whose ISO form Postgres cannot read: 400, not 500.
    for (const millis of ['253402300800000', '999999999999999']) {
      const crafted = Buffer.from(`${millis}.${randomUUID()}`).toString('base64url');
      expect(() => decodeBetCursor(crafted)).toThrow(DomainError);
      await expect(
        listUserBets(handle.db, { userId: userId0, status: 'open', limit: 5, cursor: crafted }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    }
    const userId = await createUser(handle.db);
    await expect(
      listUserBets(handle.db, { userId, status: 'open', limit: 5, cursor: 'nope' }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    await expect(listUserBets(handle.db, { userId, status: 'open', limit: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

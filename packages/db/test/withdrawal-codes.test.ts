import { createHash, randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashDeposit,
  createWithdrawalCode,
  expireWithdrawalCodes,
  findWithdrawalCodeAtShop,
  getLiveWithdrawalCode,
  listShops,
  maskPhone,
  openShift,
  payWithdrawalCode,
  WITHDRAWAL_CODE_SHOP_ATTEMPTS,
  WITHDRAWAL_CODE_TTL_MS,
} from '../src/cashier/index';
import { DomainError } from '../src/errors';
import { adminUsers, cashWithdrawalCodes, payouts } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { cashOf, createPlayer, expectBooksBalanced, NOW, rules } from './payments-fixtures';

/**
 * Withdrawal codes (docs/plans/counter-codes-and-deposit-recovery.md, G4): asked for in the app
 * with the amount (held at once), paid by the code alone at a shop with player cash on, one use,
 * five wrong codes a day lock a shop's code entry, and an unused code gives the money back.
 */

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;
let handle: TestDb;
let shopId: string;
const RULES = rules();
// The API keys this with its secret; any hex hash will do here.
const hash = (code: string) => createHash('sha256').update(`withdraw:${code}`).digest('hex');

beforeAll(async () => {
  handle = await createTestDatabase();
  const [shop] = await listShops(handle.db);
  shopId = shop!.id;
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function cashier(): Promise<string> {
  const [row] = await handle.db
    .insert(adminUsers)
    .values({
      email: `cashier-${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
      displayName: 'Test cashier',
      role: 'cashier',
    })
    .returning({ id: adminUsers.id });
  return row!.id;
}

/** A cashier with an open shift and a player with `balance` ETB of cash. */
async function desk(balance: bigint) {
  const staffId = await cashier();
  const shift = await handle.db.transaction((tx) =>
    openShift(tx, { staffId, shopId, openingFloat: birr(5_000), now: NOW }),
  );
  const player = await createPlayer(handle.db, { kyc: 'verified', name: 'Abebe Kebede' });
  await handle.db.transaction((tx) =>
    cashDeposit(tx, {
      staffId,
      shiftId: shift.id,
      userId: player.userId,
      amount: balance,
      idempotencyKey: `desk-${randomUUID()}`,
      rules: RULES,
      now: NOW,
    }),
  );
  return { staffId, shift, player };
}

const ask = (userId: string, amount: bigint, code: string, now = NOW) =>
  handle.db.transaction((tx) =>
    createWithdrawalCode(tx, {
      userId,
      amount,
      codeHash: hash(code),
      idempotencyKey: `code-${randomUUID()}`,
      rules: RULES,
      now,
    }),
  );

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('withdrawal codes', () => {
  it('holds the money at once, then pays it by the code alone, once', async () => {
    const { staffId, shift, player } = await desk(birr(1_000));
    const made = await ask(player.userId, birr(400), '734519');
    expect(made.payout).toMatchObject({ status: 'approved', provider: 'cash', amount: birr(400) });
    expect(made.code.expiresAt.getTime()).toBe(NOW.getTime() + WITHDRAWAL_CODE_TTL_MS);
    expect(await cashOf(handle.db, player.userId)).toBe(birr(600));
    expect(
      await getLiveWithdrawalCode(handle.db, { userId: player.userId, now: NOW }),
    ).not.toBeNull();

    const found = await findWithdrawalCodeAtShop(handle.db, {
      shopId,
      codeHash: hash('734519'),
      now: NOW,
    });
    expect(found).toMatchObject({
      amount: birr(400),
      status: 'approved',
      playerName: 'Abebe Kebede',
      maskedPhone: maskPhone(player.phone),
    });
    const key = `desk-${randomUUID()}`;
    const pay = () =>
      handle.db.transaction((tx) =>
        payWithdrawalCode(tx, {
          staffId,
          shiftId: shift.id,
          codeId: found.codeId,
          idempotencyKey: key,
          now: NOW,
        }),
      );
    const paid = await pay();
    expect(paid).toMatchObject({
      replayed: false,
      operation: { kind: 'withdrawal', amount: birr(400) },
    });
    expect((await pay()).replayed).toBe(true);
    const [payout] = await handle.db.select().from(payouts).where(eq(payouts.id, made.payout.id));
    expect(payout).toMatchObject({ status: 'paid', provider: 'cash' });
    // One use: the code is no longer live.
    expect(
      await refusal(
        findWithdrawalCodeAtShop(handle.db, { shopId, codeHash: hash('734519'), now: NOW }),
      ),
    ).toEqual({ status: 422, code: 'withdrawal_code_wrong' });
    await expectBooksBalanced(handle.db);
  });

  it('a newer code replaces the older one and gives its money back', async () => {
    const { player } = await desk(birr(1_000));
    const first = await ask(player.userId, birr(300), '111222');
    const second = await ask(player.userId, birr(500), '333444');
    expect(second.replaced).toBe(true);
    const [old] = await handle.db.select().from(payouts).where(eq(payouts.id, first.payout.id));
    expect(old?.status).toBe('cancelled');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(500));
    const [oldCode] = await handle.db
      .select()
      .from(cashWithdrawalCodes)
      .where(eq(cashWithdrawalCodes.id, first.code.id));
    expect(oldCode?.closedAt).not.toBeNull();
  });

  it('winnings only and every online rule still apply', async () => {
    const { player } = await desk(birr(100));
    expect(await refusal(ask(player.userId, birr(500), '555666'))).toMatchObject({ status: 422 });
  });

  it(`locks a shop's code entry after ${WITHDRAWAL_CODE_SHOP_ATTEMPTS} wrong codes in a day`, async () => {
    const shops = await listShops(handle.db);
    const shop = shops[0]!.id;
    const wrong = (code: string, now = NOW) =>
      refusal(findWithdrawalCodeAtShop(handle.db, { shopId: shop, codeHash: hash(code), now }));
    // Earlier tests may have counted some today: start the count on a fresh day.
    const day = new Date(NOW.getTime() + 3 * 86_400_000);
    const results = [];
    for (let i = 0; i < WITHDRAWAL_CODE_SHOP_ATTEMPTS; i += 1)
      results.push(await wrong(`90000${i}`, day));
    expect(results.every((r) => r.code === 'withdrawal_code_wrong')).toBe(true);
    expect(await wrong('900009', day)).toEqual({ status: 409, code: 'withdrawal_codes_locked' });
    // The next day the shop may type codes again.
    expect((await wrong('900009', new Date(day.getTime() + 86_400_000))).code).toBe(
      'withdrawal_code_wrong',
    );
  });

  it('a code not used in time gives the money back', async () => {
    const { player } = await desk(birr(1_000));
    const made = await ask(player.userId, birr(250), '777888');
    expect(await expireWithdrawalCodes(handle.db, { now: NOW })).toBe(0);
    const later = new Date(NOW.getTime() + WITHDRAWAL_CODE_TTL_MS + 1);
    expect(await expireWithdrawalCodes(handle.db, { now: later })).toBeGreaterThanOrEqual(1);
    const [payout] = await handle.db.select().from(payouts).where(eq(payouts.id, made.payout.id));
    expect(payout?.status).toBe('failed');
    expect(await cashOf(handle.db, player.userId)).toBe(birr(1_000));
    await expectBooksBalanced(handle.db);
  });
});

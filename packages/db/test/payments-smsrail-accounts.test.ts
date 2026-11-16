import { birr, MAX_SANTIM_OFFSET, santimToBirrString } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmsDepositIntent, getDepositIntent, ingestSms } from '../src/index';
import type { Database } from '../src/client';
import { paymentIntents, receivedSms } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase, pgCode } from './helpers';
import { cashOf, createPlayer, domainError, idemKey, NOW, rules } from './payments-fixtures';

/** Each collection account has its own space of exact amounts (B2b). */

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database;
beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const TWO = ['telebirr:0911000001', 'telebirr:0911000002'] as const;
const A = TWO[0];
const B = TWO[1];

async function open(
  userId: string,
  amount: bigint,
  options: { accounts?: readonly string[]; offset?: number } = {},
) {
  const { intent } = await db.transaction((tx) =>
    createSmsDepositIntent(tx, {
      userId,
      amount,
      idempotencyKey: idemKey('acct'),
      now: NOW,
      rules: rules(),
      ...(options.accounts === undefined ? {} : { collectionAccounts: options.accounts }),
      ...(options.offset === undefined ? {} : { randomOffset: () => options.offset! }),
    }),
  );
  return intent;
}

let refs = 0;
function credit(amount: bigint, phone: string): string {
  refs += 1;
  return `Dear CUSTOMER, you have received ETB ${santimToBirrString(amount)} from SENDER NAME (${phone.slice(1)}) on 10/10/2026 at 12:01:00 PM. Your transaction number is ACC${String(refs).padStart(7, '0')}.`;
}

async function gateway(text: string, account: string | null | undefined) {
  return db.transaction((tx) =>
    ingestSms(tx, {
      source: 'gateway',
      sender: 'telebirr',
      text,
      now: at(1),
      ...(account === undefined ? {} : { collectionAccount: account }),
    }),
  );
}

describe('SMS deposits per collection account', () => {
  it('gives two accounts twice the open deposits of one for the same amount', async () => {
    const base = birr(500);
    const players = await Promise.all(
      Array.from({ length: 2 * MAX_SANTIM_OFFSET }, () => createPlayer(db)),
    );
    // Concurrently: the allocations queue behind one lock, so none can collide.
    const intents = await Promise.all(players.map((p) => open(p.userId, base, { accounts: TWO })));
    for (const account of TWO) {
      const mine = intents.filter((i) => i.collectionAccount === account);
      expect(mine).toHaveLength(MAX_SANTIM_OFFSET);
      expect(new Set(mine.map((i) => i.amount)).size).toBe(MAX_SANTIM_OFFSET);
    }
    // Every amount is open on both accounts.
    const amounts = intents.map((i) => i.amount);
    expect(new Set(amounts).size).toBe(MAX_SANTIM_OFFSET);
    const late = await createPlayer(db);
    expect((await domainError(open(late.userId, base, { accounts: TWO }))).code).toBe(
      'sms_amount_unavailable',
    );
  });

  it('offers the account with the most free amounts, alternating while they are even', async () => {
    const base = birr(610);
    const players = await Promise.all([1, 2, 3, 4].map(() => createPlayer(db)));
    const accounts: (string | null)[] = [];
    for (const p of players)
      accounts.push((await open(p.userId, base, { accounts: TWO })).collectionAccount);
    expect(accounts).toEqual([A, B, A, B]);
  });

  it('records no account without accounts, and a lone account is always chosen', async () => {
    const player = await createPlayer(db);
    expect((await open(player.userId, birr(620))).collectionAccount).toBeNull();
    const other = await createPlayer(db);
    expect((await open(other.userId, birr(630), { accounts: [A] })).collectionAccount).toBe(A);
  });

  it('credits an SMS only to the deposit of the account it arrived on, even for the same amount', async () => {
    const base = birr(700);
    const p1 = await createPlayer(db);
    const p2 = await createPlayer(db);
    const d1 = await open(p1.userId, base, { accounts: TWO, offset: 7 });
    const d2 = await open(p2.userId, base, { accounts: TWO, offset: 7 });
    expect(d1.amount).toBe(d2.amount);
    expect([d1.collectionAccount, d2.collectionAccount]).toEqual([A, B]);

    // p2 pays the amount to account B: p1's deposit (account A) is untouched.
    const onB = await gateway(credit(d2.amount, p2.phone), B);
    expect(onB).toMatchObject({ outcome: 'credited' });
    expect(onB.intent?.id).toBe(d2.id);
    expect(await cashOf(db, p2.userId)).toBe(d2.amount);
    expect(await cashOf(db, p1.userId)).toBe(0n);
    expect((await getDepositIntent(db, d1.id))?.status).toBe('pending');

    // And p1's payment, on account A, credits p1.
    const onA = await gateway(credit(d1.amount, p1.phone), A);
    expect(onA.intent?.id).toBe(d1.id);
    expect(await cashOf(db, p1.userId)).toBe(d1.amount);
  });

  it('leaves a payment on an account with no such deposit for review, crediting nobody', async () => {
    const p = await createPlayer(db);
    const d = await open(p.userId, birr(710), { accounts: [A], offset: 9 });
    const wrong = await gateway(credit(d.amount, p.phone), B);
    expect(wrong.outcome).toBe('unmatched');
    expect(wrong.sms.collectionAccount).toBe(B);
    expect(await cashOf(db, p.userId)).toBe(0n);
    expect((await getDepositIntent(db, d.id))?.status).toBe('pending');
  });

  it('never lets an SMS of unknown account pay a deposit that names an account', async () => {
    const p = await createPlayer(db);
    const d = await open(p.userId, birr(720), { accounts: [A], offset: 3 });
    for (const account of [undefined, null]) {
      const result = await gateway(credit(d.amount, p.phone), account);
      expect(result.outcome).toBe('unmatched');
      expect(await cashOf(db, p.userId)).toBe(0n);
      // Another delivery of the same text is a duplicate, so use a fresh reference each time.
    }
    expect((await getDepositIntent(db, d.id))?.status).toBe('pending');
  });

  it('lets a deposit from before accounts (no account) be paid on any account, and blocks its amount everywhere', async () => {
    const legacy = await createPlayer(db);
    const old = await open(legacy.userId, birr(730), { offset: 11 });
    expect(old.collectionAccount).toBeNull();
    // New deposits on either account avoid the legacy amount.
    const more = await Promise.all(
      Array.from({ length: 40 }, async () =>
        open((await createPlayer(db)).userId, birr(730), { accounts: TWO }),
      ),
    );
    expect(more.some((i) => i.amount === old.amount)).toBe(false);
    const paid = await gateway(credit(old.amount, legacy.phone), B);
    expect(paid.intent?.id).toBe(old.id);
    expect(await cashOf(db, legacy.userId)).toBe(old.amount);
  });

  it('credits once however often the same SMS is forwarded to its account', async () => {
    const p = await createPlayer(db);
    const d = await open(p.userId, birr(740), { accounts: TWO, offset: 13 });
    const text = credit(d.amount, p.phone);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        gateway(text, d.collectionAccount).then(
          (r) => r.outcome,
          () => 'error',
        ),
      ),
    );
    const outcomes = results;
    expect(outcomes.filter((o) => o === 'credited')).toHaveLength(1);
    expect(outcomes.every((o) => o === 'credited' || o === 'duplicate')).toBe(true);
    expect(await cashOf(db, p.userId)).toBe(d.amount);
    const [row] = await db.select().from(receivedSms).where(eq(receivedSms.matchedIntentId, d.id));
    expect(row?.collectionAccount).toBe(d.collectionAccount);
  });

  it('still refuses a duplicate amount on one account at the database', async () => {
    const p = await createPlayer(db);
    const d = await open(p.userId, birr(750), { accounts: [A], offset: 5 });
    const q = await createPlayer(db);
    const e = await open(q.userId, birr(751), { accounts: [B], offset: 5 });
    // The same exact amount on account B is allowed by the index: d is on A, so make one on B.
    const f = await open((await createPlayer(db)).userId, birr(750), { accounts: [B], offset: 5 });
    expect(f.amount).toBe(d.amount);
    expect(e.collectionAccount).toBe(B);
    const err = await db
      .update(paymentIntents)
      .set({ collectionAccount: A })
      .where(eq(paymentIntents.id, f.id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(err).not.toBeNull();
    expect(pgCode(err)).toBe('23505');
  });
});

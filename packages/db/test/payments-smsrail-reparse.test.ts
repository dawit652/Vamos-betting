import { randomUUID } from 'node:crypto';
import { birr, santimToBirrString } from '@vamos/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSmsDepositIntent, reparseSmsByStaff } from '../src/index';
import type { Database } from '../src/client';
import { receivedSms } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';
import { cashOf, createPlayer, domainError, idemKey, NOW, rules } from './payments-fixtures';

/** Re-reading a message no parser could read (B6). */

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database;
beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});
afterAll(async () => {
  await dropTestDatabase(handle);
});

const ADMIN = '0f0e0d0c-0b0a-4908-8706-050403020100';
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

async function open(userId: string, amount: bigint, now: Date) {
  const { intent } = await db.transaction((tx) =>
    createSmsDepositIntent(tx, {
      userId,
      amount,
      idempotencyKey: idemKey('rp'),
      now,
      rules: rules(),
    }),
  );
  return intent;
}

let refs = 0;
const ref = () => `RP${String((refs += 1)).padStart(8, '0')}`;
/** What the money moved as (10/10/2026 12:01 PM EAT = 09:01Z = at(1)). */
const creditText = (amount: bigint, phone: string, reference: string) =>
  `Dear CUSTOMER, you have received ETB ${santimToBirrString(amount)} from SENDER NAME (${phone.slice(1)}) on 10/10/2026 at 12:01:00 PM. Your transaction number is ${reference}.`;

/** A message stored as unread (as when the parser did not know its shape yet). */
async function storeUnread(rawText: string) {
  const [row] = await db
    .insert(receivedSms)
    .values({
      source: 'gateway',
      sender: 'telebirr',
      rawText,
      textHash: randomUUID(),
      receivedAt: at(1),
      status: 'unparsed',
      createdAt: at(1),
      updatedAt: at(1),
    })
    .returning();
  return row!;
}

const reparse = (smsId: string, now = at(30)) =>
  db.transaction((tx) => reparseSmsByStaff(tx, { smsId, adminId: ADMIN, now }));

describe('reparseSmsByStaff', () => {
  it('reads the stored text, credits the deposit it pays once, and then refuses a second read', async () => {
    const player = await createPlayer(db);
    const deposit = await open(player.userId, birr(100), NOW);
    const row = await storeUnread(creditText(deposit.amount, player.phone, ref()));
    const result = await reparse(row.id);
    expect(result.outcome).toBe('credited');
    expect(result.intent?.id).toBe(deposit.id);
    expect(result.sms).toMatchObject({ status: 'matched', amount: deposit.amount });
    expect(await cashOf(db, player.userId)).toBe(deposit.amount);
    const err = await domainError(reparse(row.id));
    expect(err.code).toBe('sms_not_reparseable');
    expect(await cashOf(db, player.userId)).toBe(deposit.amount);
  });

  it('leaves it for a person once the deposit has left its quarantine', async () => {
    const player = await createPlayer(db);
    const deposit = await open(player.userId, birr(150), NOW);
    const row = await storeUnread(creditText(deposit.amount, player.phone, ref()));
    const result = await reparse(row.id, at(600));
    expect(result.outcome).toBe('unmatched');
    expect(await cashOf(db, player.userId)).toBe(0n);
  });

  it('never pays a deposit opened after the money moved, even for the same amount', async () => {
    const player = await createPlayer(db);
    const late = await open(player.userId, birr(200), at(30));
    const row = await storeUnread(creditText(late.amount, player.phone, ref()));
    const result = await reparse(row.id);
    expect(result.outcome).toBe('unmatched');
    expect(await cashOf(db, player.userId)).toBe(0n);
    // It was read, so it waits in the review queue for a person.
    expect(result.sms.status).toBe('unmatched');
  });

  it('leaves a message that is still unreadable as it was', async () => {
    const row = await storeUnread('hello, nothing a parser would know');
    const result = await reparse(row.id);
    expect(result.outcome).toBe('unparsed');
    const [after] = await db.select().from(receivedSms).where(eq(receivedSms.id, row.id));
    expect(after).toMatchObject({ status: 'unparsed', reference: null, amount: null });
  });

  it('refuses a reference another message already carries', async () => {
    const player = await createPlayer(db);
    const reference = ref();
    const first = await storeUnread(creditText(birr(50), player.phone, reference));
    await reparse(first.id);
    const second = await storeUnread(creditText(birr(50), player.phone, reference) + ' ');
    expect((await domainError(reparse(second.id))).code).toBe('sms_duplicate_reference');
  });

  it('only an unread row may be filled in: a parsed row keeps its parsed fields', async () => {
    const player = await createPlayer(db);
    const row = await storeUnread(creditText(birr(60), player.phone, ref()));
    await reparse(row.id);
    await expect(
      db
        .update(receivedSms)
        .set({ amount: birr(1) })
        .where(eq(receivedSms.id, row.id)),
    ).rejects.toThrow();
  });
});

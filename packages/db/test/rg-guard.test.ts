import { randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCanGamble,
  assertDepositAllowed,
  assertStakeAllowed,
  DomainError,
  getActiveExclusion,
  lockUser,
  postTransaction,
} from '../src/index';
import { rgExclusions, rgLimits, users } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { cash, createUser, dropTestDatabase, fund, uniqueKey } from './helpers';
import { eq } from 'drizzle-orm';

let handle: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

async function caught(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a DomainError');
}

describe('DomainError', () => {
  it('carries status, code, message and details, and renders the API error body', () => {
    const error = new DomainError(422, 'some_code', 'Something is wrong.', { a: '1' });
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(422);
    expect(error.statusCode).toBe(422);
    expect(error.toBody()).toEqual({
      error: { code: 'some_code', message: 'Something is wrong.', details: { a: '1' } },
    });
    expect(new DomainError(404, 'not_found', 'x').toBody()).toEqual({
      error: { code: 'not_found', message: 'x' },
    });
  });
});

describe('shared RG guard', () => {
  it('lockUser and assertCanGamble: 404 not_found for an unknown user', async () => {
    const missing = randomUUID();
    const locked = await caught(handle.db.transaction((tx) => lockUser(tx, missing)));
    expect(locked).toMatchObject({ status: 404, code: 'not_found', message: 'User not found' });
    const gamble = await caught(assertCanGamble(handle.db, missing, new Date()));
    expect(gamble).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('403 account_disabled for a suspended account', async () => {
    const userId = await createUser(handle.db);
    await handle.db.update(users).set({ status: 'suspended' }).where(eq(users.id, userId));
    const error = await caught(assertStakeAllowed(handle.db, userId, birr(10), new Date()));
    expect(error).toMatchObject({
      status: 403,
      code: 'account_disabled',
      details: { status: 'suspended' },
    });
  });

  it('403 self_excluded / cooling_off with the end date', async () => {
    const now = new Date();
    const excluded = await createUser(handle.db);
    await handle.db
      .insert(rgExclusions)
      .values({ userId: excluded, kind: 'self_exclusion', startsAt: now, endsAt: null });
    const error = await caught(assertCanGamble(handle.db, excluded, now));
    expect(error).toMatchObject({
      status: 403,
      code: 'self_excluded',
      details: { kind: 'self_exclusion', endsAt: null },
    });

    const cooling = await createUser(handle.db);
    const endsAt = new Date(now.getTime() + 86_400_000);
    await handle.db
      .insert(rgExclusions)
      .values({ userId: cooling, kind: 'cool_off', startsAt: now, endsAt });
    expect(await getActiveExclusion(handle.db, cooling, now)).toMatchObject({ kind: 'cool_off' });
    const cool = await caught(assertDepositAllowed(handle.db, cooling, birr(10), now));
    expect(cool).toMatchObject({
      status: 403,
      code: 'cooling_off',
      details: { endsAt: endsAt.toISOString() },
    });
  });

  it('422 stake_limit_exceeded and loss_limit_exceeded with santim string details', async () => {
    const now = new Date();
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(1_000));
    await handle.db.insert(rgLimits).values([
      {
        userId,
        kind: 'stake',
        period: 'bet',
        amount: birr(100),
        effectiveFrom: now,
        createdAt: now,
      },
      {
        userId,
        kind: 'loss',
        period: 'day',
        amount: birr(150),
        effectiveFrom: now,
        createdAt: now,
      },
    ]);
    expect(await caught(assertStakeAllowed(handle.db, userId, birr(101), now))).toMatchObject({
      status: 422,
      code: 'stake_limit_exceeded',
      details: { period: 'bet', limit: '10000', stake: '10100' },
    });
    await assertStakeAllowed(handle.db, userId, birr(100), now);
    await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'bet_stake',
        idempotencyKey: uniqueKey('stake'),
        entries: [
          { account: cash(userId), amount: -birr(100) },
          { account: { kind: 'house_stakes' }, amount: birr(100) },
        ],
      }),
    );
    expect(await caught(assertStakeAllowed(handle.db, userId, birr(51), now))).toMatchObject({
      status: 422,
      code: 'loss_limit_exceeded',
      details: { period: 'day', limit: '15000', used: '10000' },
    });
    await assertStakeAllowed(handle.db, userId, birr(50), now);
  });

  it('treats a non-positive amount as a programming error', async () => {
    const userId = await createUser(handle.db);
    await expect(assertStakeAllowed(handle.db, userId, 0n, new Date())).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(assertDepositAllowed(handle.db, userId, -1n, new Date())).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

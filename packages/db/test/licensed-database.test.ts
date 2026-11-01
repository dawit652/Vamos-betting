import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOperatingMode,
  ensureAccount,
  getBalance,
  getDatabaseOperatingMode,
  OperatingModeMismatchError,
  postTransaction,
} from '../src/index';
import { houseAccountKinds, seed } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { cash, createUser, dropTestDatabase, errorText, pgCode, uniqueKey } from './helpers';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

describe('a licensed database', () => {
  it('is claimed by a licensed seed, which opens no demo funding account', async () => {
    expect(houseAccountKinds('licensed')).not.toContain('house_demo_funding');
    expect(houseAccountKinds('demo')).toContain('house_demo_funding');
    expect(houseAccountKinds(null)).toContain('house_demo_funding');

    expect(await seed(handle.db, { mode: 'licensed' })).toEqual({
      houseAccounts: 6,
      settingsCreated: 9,
    });
    expect(await getDatabaseOperatingMode(handle.db)).toBe('licensed');
    // Without a mode the seed follows the recorded one.
    expect(await seed(handle.db)).toEqual({ houseAccounts: 6, settingsCreated: 0 });
  });

  it('refuses demo mode', async () => {
    await expect(claimOperatingMode(handle.db, 'demo')).rejects.toBeInstanceOf(
      OperatingModeMismatchError,
    );
    await expect(seed(handle.db, { mode: 'demo' })).rejects.toMatchObject({
      recorded: 'licensed',
      configured: 'demo',
    });
  });

  it('refuses play money: demo top-ups and the demo funding account', async () => {
    const userId = await createUser(handle.db);
    const topUp = await handle.db
      .transaction((tx) =>
        postTransaction(tx, {
          type: 'demo_topup',
          idempotencyKey: uniqueKey('topup'),
          entries: [
            { account: { kind: 'house_demo_funding' }, amount: -100_000n },
            { account: cash(userId), amount: 100_000n },
          ],
        }),
      )
      .catch((e: unknown) => e);
    expect(errorText(topUp)).toMatch(/play money is not allowed in a licensed database/);
    expect(pgCode(topUp)).toBe('23001');

    const funding = await ensureAccount(handle.db, { kind: 'house_demo_funding' }).catch(
      (e: unknown) => e,
    );
    expect(errorText(funding)).toMatch(/play money is not allowed in a licensed database/);
    expect(await getBalance(handle.db, cash(userId))).toBe(0n);
  });

  it('still posts real-money transactions', async () => {
    const userId = await createUser(handle.db);
    const result = await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'deposit',
        idempotencyKey: uniqueKey('deposit'),
        entries: [
          { account: { kind: 'house_psp_clearing', provider: 'telebirr' }, amount: -25_000n },
          { account: cash(userId), amount: 25_000n },
        ],
      }),
    );
    expect(result.created).toBe(true);
    expect(await getBalance(handle.db, cash(userId))).toBe(25_000n);
  });
});

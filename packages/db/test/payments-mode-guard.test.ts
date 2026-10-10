import { birr } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimOperatingMode,
  createDepositIntent,
  ensureAccount,
  getDatabaseOperatingMode,
  OperatingModeMismatchError,
} from '../src/index';
import { databaseIdentity, payouts } from '../src/schema/index';
import { seed } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase, errorText, pgCode } from './helpers';
import { createPlayer, idemKey, NOW, rules } from './payments-fixtures';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

/**
 * Mock-provider payments are play money: a database holding them is never
 * claimed for licensed mode, and a licensed database refuses them.
 */
describe('mock payments and the operating mode', () => {
  let demo: TestDb;
  let licensed: TestDb;

  beforeAll(async () => {
    [demo, licensed] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    await seed(licensed.db, { mode: 'licensed' });
  });

  afterAll(async () => {
    await Promise.all([dropTestDatabase(demo), dropTestDatabase(licensed)]);
  });

  const intent = (db: TestDb['db'], userId: string, provider: string) =>
    db.transaction((tx) =>
      createDepositIntent(tx, {
        userId,
        provider,
        amount: birr(100),
        idempotencyKey: idemKey(),
        now: NOW,
        rules: rules(),
      }),
    );

  it('refuses to claim a database with mock deposit intents or the mock PSP account for licensed mode', async () => {
    const player = await createPlayer(demo.db, { kyc: 'none' });
    await intent(demo.db, player.userId, 'mock');
    const claim = claimOperatingMode(demo.db, 'licensed');
    await expect(claim).rejects.toBeInstanceOf(OperatingModeMismatchError);
    await expect(claim).rejects.toMatchObject({
      message: expect.stringMatching(/mock payment provider/),
    });
    const raw = await demo.db
      .insert(databaseIdentity)
      .values({ operatingMode: 'licensed' })
      .catch((e: unknown) => e);
    expect(errorText(raw)).toMatch(/mock payment provider/);
    expect(pgCode(raw)).toBe('23001');
    expect(await getDatabaseOperatingMode(demo.db)).toBeNull();
  });

  it('lets a licensed database refuse mock intents, payouts and the mock PSP account', async () => {
    const player = await createPlayer(licensed.db, { kyc: 'none' });
    const mockIntent = await intent(licensed.db, player.userId, 'mock').catch((e: unknown) => e);
    expect(errorText(mockIntent)).toMatch(/play money is not allowed in a licensed database/);
    expect(pgCode(mockIntent)).toBe('23001');

    const account = await ensureAccount(licensed.db, {
      kind: 'house_psp_clearing',
      provider: 'mock',
    }).catch((e: unknown) => e);
    expect(errorText(account)).toMatch(/play money is not allowed/);

    const payout = await licensed.db
      .insert(payouts)
      .values({
        userId: player.userId,
        provider: 'mock',
        amount: birr(100),
        phone: player.phone,
        recipientName: 'Abebe Kebede',
        status: 'requested',
        idempotencyKey: idemKey(),
        holdLedgerTransactionId: '00000000-0000-4000-8000-000000000000',
        requestedAt: NOW,
        updatedAt: NOW,
      })
      .catch((e: unknown) => e);
    expect(errorText(payout)).toMatch(/play money is not allowed/);

    // Real providers are fine.
    const { intent: real } = await intent(licensed.db, player.userId, 'chapa');
    expect(real.provider).toBe('chapa');
    await expect(
      ensureAccount(licensed.db, { kind: 'house_psp_clearing', provider: 'telebirr' }),
    ).resolves.toMatchObject({ key: 'house:psp:telebirr' });
  });
});

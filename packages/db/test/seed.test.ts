import {
  DEFAULT_BET_RULES,
  DEFAULT_JACKPOTS,
  DEFAULT_LIVE_BET_DELAY_MS,
  DEFAULT_MULTI_BONUS,
  DEFAULT_RESPONSIBLE_GAMBLING,
  DEFAULT_TAX,
} from '@vamos/core';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountKey, getSetting, postTransaction, setSetting, toJsonSafe } from '../src/index';
import { ledgerAccounts, settings } from '../src/schema/index';
import { DEFAULT_SETTINGS, HOUSE_ACCOUNT_KINDS, SEED_ACTOR, seed } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { createUser, dropTestDatabase, fund, uniqueKey } from './helpers';

type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDatabase();
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const SETTING_KEYS = [
  'bet_rules',
  'cash_out',
  'jackpots',
  'live_bet_delay_ms',
  'market_families',
  'multi_bonus',
  'payments',
  'responsible_gambling',
  'risk_limits',
  'tax',
];

async function houseAccounts() {
  return handle.db
    .select({
      id: ledgerAccounts.id,
      key: ledgerAccounts.key,
      kind: ledgerAccounts.kind,
      ownerType: ledgerAccounts.ownerType,
      userId: ledgerAccounts.userId,
      balance: ledgerAccounts.balance,
      allowNegative: ledgerAccounts.allowNegative,
      currency: ledgerAccounts.currency,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.ownerType, 'house'))
    .orderBy(asc(ledgerAccounts.key));
}

async function settingRows() {
  return handle.db
    .select({
      key: settings.key,
      value: sql<string>`${settings.value}::text`,
      updatedBy: settings.updatedBy,
      updatedAt: settings.updatedAt,
    })
    .from(settings)
    .orderBy(asc(settings.key));
}

describe('seed', () => {
  it('opens every house account and writes the default settings on an empty database', async () => {
    const summary = await seed(handle.db);
    expect(summary).toEqual({ houseAccounts: 7, settingsCreated: 9 });

    const accounts = await houseAccounts();
    expect(accounts.map((a) => a.key)).toEqual(
      [...HOUSE_ACCOUNT_KINDS].map((kind) => accountKey({ kind })).sort(),
    );
    expect(accounts.map((a) => a.key)).toEqual([
      'house:demo_funding',
      'house:jackpot',
      'house:promotions',
      'house:revenue',
      'house:stakes',
      'house:tax_payable',
      'house:withdrawals_pending',
    ]);
    for (const account of accounts) {
      expect(account).toMatchObject({
        ownerType: 'house',
        userId: null,
        balance: 0n,
        allowNegative: true,
        currency: 'ETB',
      });
    }

    const rows = await settingRows();
    expect(rows.map((r) => r.key)).toEqual(SETTING_KEYS);
    for (const row of rows) {
      expect(row.updatedBy).toBe(SEED_ACTOR);
      expect(JSON.parse(row.value)).toEqual(toJsonSafe(DEFAULT_SETTINGS[row.key]));
    }
  });

  it('stores money as santim strings and plain numbers as numbers', async () => {
    const betRules = await getSetting<Record<string, unknown>>(handle.db, 'bet_rules');
    expect(betRules).toEqual({
      minStake: '500',
      maxStake: '10000000',
      maxPayout: '50000000',
      maxLegs: 40,
      minLegOddsMilli: 1010,
      maxTotalOddsMilli: '1000000000',
    });
    expect(BigInt(betRules!.minStake as string)).toBe(DEFAULT_BET_RULES.minStake);

    const multiBonus = await getSetting<{ tiers: unknown[]; maxBonus: string }>(
      handle.db,
      'multi_bonus',
    );
    expect(multiBonus?.tiers).toEqual(DEFAULT_MULTI_BONUS.tiers);
    expect(multiBonus?.maxBonus).toBe(DEFAULT_MULTI_BONUS.maxBonus.toString());

    expect(await getSetting(handle.db, 'tax')).toEqual({
      rateBps: DEFAULT_TAX.rateBps,
      base: DEFAULT_TAX.base,
      exemptBelow: DEFAULT_TAX.exemptBelow.toString(),
    });
    expect(await getSetting(handle.db, 'live_bet_delay_ms')).toBe(DEFAULT_LIVE_BET_DELAY_MS);
    expect(await getSetting(handle.db, 'responsible_gambling')).toEqual(
      DEFAULT_RESPONSIBLE_GAMBLING,
    );

    const jackpots = await getSetting<Record<string, { prizeTiers: Array<{ amount: string }> }>>(
      handle.db,
      'jackpots',
    );
    expect(Object.keys(jackpots ?? {}).sort()).toEqual(['daily9', 'weekly13']);
    expect(jackpots?.weekly13?.prizeTiers[0]?.amount).toBe(
      DEFAULT_JACKPOTS.weekly13.prizeTiers[0]?.amount.toString(),
    );
  });

  it('is idempotent: a second run creates nothing and changes nothing', async () => {
    const accountsBefore = await houseAccounts();
    const settingsBefore = await settingRows();

    const summary = await seed(handle.db);
    expect(summary).toEqual({ houseAccounts: 7, settingsCreated: 0 });

    expect(await houseAccounts()).toEqual(accountsBefore);
    expect(await settingRows()).toEqual(settingsBefore);
  });

  it('never overwrites edited settings or touches house balances, and restores missing ones', async () => {
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, 12_345n);
    await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'bet_stake',
        idempotencyKey: uniqueKey('stake'),
        entries: [
          { account: { kind: 'player_cash', userId }, amount: -2_000n },
          { account: { kind: 'house_stakes' }, amount: 2_000n },
        ],
      }),
    );
    const editedTax = { rateBps: 2_500, base: 'gross_payout', exemptBelow: 0n };
    await setSetting(handle.db, 'tax', editedTax, 'admin:compliance');
    await handle.db.delete(settings).where(eq(settings.key, 'jackpots'));
    const accountsBefore = await houseAccounts();

    const summary = await seed(handle.db);
    expect(summary).toEqual({ houseAccounts: 7, settingsCreated: 1 });

    expect(await getSetting(handle.db, 'tax')).toEqual(toJsonSafe(editedTax));
    const [taxRow] = await handle.db.select().from(settings).where(eq(settings.key, 'tax'));
    expect(taxRow?.updatedBy).toBe('admin:compliance');
    expect(await getSetting(handle.db, 'jackpots')).toEqual(toJsonSafe(DEFAULT_JACKPOTS));

    const accountsAfter = await houseAccounts();
    expect(accountsAfter).toEqual(accountsBefore);
    const balances = Object.fromEntries(accountsAfter.map((a) => [a.key, a.balance]));
    expect(balances['house:demo_funding']).toBe(-12_345n);
    expect(balances['house:stakes']).toBe(2_000n);
  });

  it('is safe to run concurrently', async () => {
    await handle.db.delete(settings);

    const results = await Promise.all([seed(handle.db), seed(handle.db), seed(handle.db)]);
    for (const result of results) expect(result.houseAccounts).toBe(7);
    expect(results.reduce((sum, r) => sum + (r.settingsCreated ?? 0), 0)).toBe(9);

    expect((await settingRows()).map((r) => r.key)).toEqual(SETTING_KEYS);
    expect(await houseAccounts()).toHaveLength(7);
  });
});

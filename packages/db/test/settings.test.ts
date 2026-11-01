import {
  birr,
  DEFAULT_BET_RULES,
  DEFAULT_JACKPOTS,
  DEFAULT_PAYMENT_RULES,
  DEFAULT_TAX,
} from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTING_KEYS,
  InvalidSettingError,
  loadGameSettings,
  parseGameSettings,
  parseTerms,
  serializeTerms,
  setSetting,
} from '../src/index';
import { DEFAULT_SETTINGS, seed } from '../src/seed/index';
import { createTestDatabase } from '../src/testing';
import { dropTestDatabase } from './helpers';

describe('parseGameSettings', () => {
  it('falls back to every core default when nothing is stored', () => {
    expect(parseGameSettings({})).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('parses santim strings as bigint and keeps numbers as numbers', () => {
    const parsed = parseGameSettings({
      bet_rules: {
        minStake: '1000',
        maxStake: '5000000',
        maxPayout: '9000000',
        maxLegs: 20,
        minLegOddsMilli: 1100,
        maxTotalOddsMilli: '5000000',
      },
    });
    expect(parsed.betRules).toEqual({
      minStake: 1000n,
      maxStake: 5_000_000n,
      maxPayout: 9_000_000n,
      maxLegs: 20,
      minLegOddsMilli: 1100,
      maxTotalOddsMilli: 5_000_000n,
    });
  });

  it('fills missing fields of a stored object from the default', () => {
    const parsed = parseGameSettings({ tax: { rateBps: 2500 }, live_bet_delay_ms: 3000 });
    expect(parsed.tax).toEqual({ ...DEFAULT_TAX, rateBps: 2500 });
    expect(parsed.liveBetDelayMs).toBe(3000);
  });

  it('parses the payments block (santim strings) over the defaults', () => {
    const parsed = parseGameSettings({
      payments: { minWithdrawal: '10000', autoApproveBelow: '0', wageringMultiplierBps: 15_000 },
    });
    expect(parsed.payments).toEqual({
      ...DEFAULT_PAYMENT_RULES,
      minWithdrawal: 10_000n,
      autoApproveBelow: 0n,
      wageringMultiplierBps: 15_000,
    });
    // The default wagering multiplier is 1.0: every deposit staked once.
    expect(DEFAULT_GAME_SETTINGS.payments.wageringMultiplierBps).toBe(10_000);
  });

  it('has no liability caps by default, and parses stored caps (santim strings) over that', () => {
    expect(DEFAULT_GAME_SETTINGS.riskLimits).toEqual({
      maxSelectionLiability: null,
      maxEventLiability: null,
    });
    const parsed = parseGameSettings({
      risk_limits: { maxSelectionLiability: '100000000', maxEventLiability: null },
    });
    expect(parsed.riskLimits).toEqual({
      maxSelectionLiability: 100_000_000n,
      maxEventLiability: null,
    });
    // A missing field keeps its default (no cap).
    expect(parseGameSettings({ risk_limits: { maxEventLiability: '5' } }).riskLimits).toEqual({
      maxSelectionLiability: null,
      maxEventLiability: 5n,
    });
  });

  it('merges jackpot templates one by one', () => {
    const parsed = parseGameSettings({ jackpots: { daily9: { costPerCombination: '2000' } } });
    expect(parsed.jackpots.daily9).toEqual({
      ...DEFAULT_JACKPOTS.daily9,
      costPerCombination: 2000n,
    });
    expect(parsed.jackpots.weekly13).toEqual(DEFAULT_JACKPOTS.weekly13);
  });

  it.each([
    ['bet_rules', { minStake: '-1' }],
    ['bet_rules', { minStake: '12.5' }],
    ['bet_rules', { minStake: '600000', maxStake: '500000' }],
    // A winning bet must return at least its stake (settlementPosting refuses less).
    ['bet_rules', { maxStake: '600000', maxPayout: '500000' }],
    [
      'multi_bonus',
      {
        tiers: [
          { minLegs: 4, percentBps: 1 },
          { minLegs: 3, percentBps: 2 },
        ],
      },
    ],
    ['tax', { base: 'everything' }],
    ['tax', { rateBps: 10_001 }],
    ['cash_out', { enabled: 'yes' }],
    ['live_bet_delay_ms', 'soon'],
    ['responsible_gambling', { minAge: 16 }],
    ['jackpots', { weekly13: { code: 'daily9' } }],
    ['payments', { minDeposit: '0' }],
    ['payments', { minDeposit: '20000000', maxDeposit: '10000000' }],
    ['payments', { minWithdrawal: '600000', maxWithdrawal: '500000' }],
    ['payments', { minWithdrawal: '5000', dailyWithdrawalCap: '4000' }],
    ['payments', { autoApproveBelow: '-1' }],
    ['payments', { wageringMultiplierBps: 1.5 }],
    ['payments', { wageringMultiplierBps: -1 }],
    ['payments', { depositIntentTtlMinutes: 0 }],
    ['payments', { payoutMaxAttempts: 0 }],
    // A cap is a positive amount or null: zero would refuse every bet.
    ['risk_limits', { maxSelectionLiability: '0' }],
    ['risk_limits', { maxEventLiability: '-5' }],
    ['risk_limits', { maxEventLiability: '12.5' }],
    ['risk_limits', { maxEventLiability: 'lots' }],
    // The selection cap cannot exceed the match cap (probably swapped).
    ['risk_limits', { maxSelectionLiability: '2000', maxEventLiability: '1000' }],
  ] as const)('rejects an invalid %s (%j), naming the key', (key, value) => {
    let error: unknown;
    try {
      parseGameSettings({ [key]: value });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidSettingError);
    expect((error as InvalidSettingError).key).toBe(key);
    expect((error as InvalidSettingError).issues.length).toBeGreaterThan(0);
  });
});

describe('parseTerms (the terms stored on a bet)', () => {
  it('round-trips the terms and refuses stored rules whose cap is below the max stake', () => {
    const terms = {
      betRules: DEFAULT_GAME_SETTINGS.betRules,
      multiBonus: DEFAULT_GAME_SETTINGS.multiBonus,
      tax: DEFAULT_GAME_SETTINGS.tax,
    };
    const stored = serializeTerms(terms);
    expect(parseTerms(stored)).toEqual(terms);
    const tampered = {
      ...stored,
      betRules: { ...stored.betRules, maxStake: '600000', maxPayout: '500000' },
    };
    expect(() => parseTerms(tampered)).toThrow(/maxStake must not exceed maxPayout/);
  });
});

describe('loadGameSettings', () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    handle = await createTestDatabase();
  });

  afterAll(async () => {
    await dropTestDatabase(handle);
  });

  it('returns the defaults on an empty database', async () => {
    expect(await loadGameSettings(handle.db)).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('round-trips the seeded defaults (santim stored as strings)', async () => {
    await seed(handle.db);
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(Object.values(GAME_SETTING_KEYS).sort());
    expect(await loadGameSettings(handle.db)).toEqual(DEFAULT_GAME_SETTINGS);
  });

  it('reads back-office edits', async () => {
    await setSetting(handle.db, 'bet_rules', { ...DEFAULT_BET_RULES, maxPayout: birr(250_000) });
    await setSetting(handle.db, 'live_bet_delay_ms', 8000);
    await setSetting(handle.db, 'payments', { dailyWithdrawalCap: birr(50_000) });
    const loaded = await loadGameSettings(handle.db);
    expect(loaded.betRules.maxPayout).toBe(birr(250_000));
    expect(loaded.liveBetDelayMs).toBe(8000);
    expect(loaded.payments).toEqual({ ...DEFAULT_PAYMENT_RULES, dailyWithdrawalCap: birr(50_000) });
    expect(loaded.tax).toEqual(DEFAULT_TAX);
  });

  it('refuses a corrupted stored value', async () => {
    await setSetting(handle.db, 'cash_out', { marginBps: -5 });
    await expect(loadGameSettings(handle.db)).rejects.toBeInstanceOf(InvalidSettingError);
  });
});

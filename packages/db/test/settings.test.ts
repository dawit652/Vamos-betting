import { birr, DEFAULT_BET_RULES, DEFAULT_JACKPOTS, DEFAULT_TAX } from '@vamos/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_GAME_SETTINGS,
  GAME_SETTING_KEYS,
  InvalidSettingError,
  loadGameSettings,
  parseGameSettings,
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
    const loaded = await loadGameSettings(handle.db);
    expect(loaded.betRules.maxPayout).toBe(birr(250_000));
    expect(loaded.liveBetDelayMs).toBe(8000);
    expect(loaded.tax).toEqual(DEFAULT_TAX);
  });

  it('refuses a corrupted stored value', async () => {
    await setSetting(handle.db, 'cash_out', { marginBps: -5 });
    await expect(loadGameSettings(handle.db)).rejects.toBeInstanceOf(InvalidSettingError);
  });
});

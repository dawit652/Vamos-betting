import { randomUUID } from 'node:crypto';
import { birr, DEFAULT_JACKPOTS, DEFAULT_MULTI_BONUS, DEFAULT_TAX } from '@vamos/core';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createJackpotRound,
  DomainError,
  getJackpotTemplates,
  getMultiBonusSettings,
  getPromotions,
  getSetting,
  loadGameSettings,
  settleEventBets,
  updateJackpotTemplate,
  updateMultiBonusSettings,
  type CatalogIds,
} from '../src/index';
import { auditLog, bets, settings as settingsTable } from '../src/schema/index';
import { createBettingDatabase, createEvent, finish, place, type TestDb } from './betting-fixtures';
import { cashOf, createGames, enter, HOUR, resultGame, settle } from './jackpot-fixtures';
import { createUser, dropTestDatabase, fund } from './helpers';

let handle: TestDb;
let ids: CatalogIds;

beforeAll(async () => {
  ({ handle, ids } = await createBettingDatabase());
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

const admin = () => ({ type: 'admin' as const, id: randomUUID(), ip: '10.0.0.1' });

async function domainError(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

/** The multi-bonus ladder as the back office would send it (santim as strings). */
function ladder(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    minLegOddsMilli: 1300,
    tiers: [
      { minLegs: 3, percentBps: 1_000 },
      { minLegs: 5, percentBps: 2_000 },
    ],
    maxBonus: '5000000',
    ...overrides,
  };
}

/** A 3-game daily template as the back office would send it. */
function smallDaily(overrides: Record<string, unknown> = {}) {
  return {
    code: 'daily9',
    enabled: true,
    gameCount: 3,
    costPerCombination: '1000',
    maxCombinations: 8,
    cancelledRule: 'all_win',
    prizeTiers: [
      { correct: 3, kind: 'shared', amount: '100000' },
      { correct: 2, kind: 'fixed', amount: '2000' },
    ],
    ...overrides,
  };
}

describe('updateMultiBonusSettings', () => {
  it('validates, stores and audits the ladder', async () => {
    const actor = admin();
    const updated = await handle.db.transaction((tx) =>
      updateMultiBonusSettings(tx, { value: ladder(), actor }),
    );
    expect(updated).toEqual({
      enabled: true,
      minLegOddsMilli: 1300,
      tiers: [
        { minLegs: 3, percentBps: 1_000 },
        { minLegs: 5, percentBps: 2_000 },
      ],
      maxBonus: birr(50_000),
    });
    expect(await getMultiBonusSettings(handle.db)).toEqual(updated);
    expect((await loadGameSettings(handle.db)).multiBonus).toEqual(updated);
    const [row] = await handle.db
      .select({ updatedBy: settingsTable.updatedBy })
      .from(settingsTable)
      .where(eq(settingsTable.key, 'multi_bonus'));
    expect(row?.updatedBy).toBe(actor.id);
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'settings.updated'), eq(auditLog.targetId, 'multi_bonus')));
    expect(audit).toMatchObject({
      actorType: 'admin',
      actorId: actor.id,
      targetType: 'setting',
      ip: '10.0.0.1',
      metadata: {
        key: 'multi_bonus',
        before: { ...DEFAULT_MULTI_BONUS, maxBonus: DEFAULT_MULTI_BONUS.maxBonus.toString() },
        after: { ...updated, maxBonus: '5000000' },
      },
    });
  });

  it('refuses an invalid ladder with 422 invalid_setting and changes nothing', async () => {
    const before = await getSetting(handle.db, 'multi_bonus');
    const cases = [
      ladder({
        tiers: [
          { minLegs: 5, percentBps: 500 },
          { minLegs: 3, percentBps: 300 },
        ],
      }),
      ladder({ tiers: [] }),
      ladder({ maxBonus: '-1' }),
      ladder({ maxBonus: 12.5 }),
      ladder({ minLegOddsMilli: 900 }),
      ladder({ tiers: [{ minLegs: 3, percentBps: 2_000_000 }] }),
      { enabled: true },
      'not an object',
    ];
    for (const value of cases) {
      const error = await domainError(
        handle.db.transaction((tx) => updateMultiBonusSettings(tx, { value, actor: admin() })),
      );
      expect(error).toMatchObject({ status: 422, code: 'invalid_setting' });
      expect(error.details).toMatchObject({ key: 'multi_bonus' });
      expect((error.details as { issues: string[] }).issues.length).toBeGreaterThan(0);
    }
    // A disabled bonus may have no tiers.
    await handle.db.transaction((tx) =>
      updateMultiBonusSettings(tx, {
        value: ladder({ enabled: false, tiers: [] }),
        actor: admin(),
      }),
    );
    await handle.db.transaction((tx) =>
      updateMultiBonusSettings(tx, { value: before, actor: admin() }),
    );
    expect(await getSetting(handle.db, 'multi_bonus')).toEqual(before);
  });

  it('needs the admin id for an admin change', async () => {
    await expect(
      handle.db.transaction((tx) =>
        updateMultiBonusSettings(tx, { value: ladder(), actor: { type: 'admin' } }),
      ),
    ).rejects.toThrow(RangeError);
  });

  it('applies to bets placed after the change only', async () => {
    await handle.db.transaction((tx) =>
      updateMultiBonusSettings(tx, {
        value: { ...DEFAULT_MULTI_BONUS, maxBonus: DEFAULT_MULTI_BONUS.maxBonus.toString() },
        actor: admin(),
      }),
    );
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(1_000));
    const events = await Promise.all([1, 2, 3].map(() => createEvent(handle.db, ids)));
    const legs = events.map((e) => ({ selectionId: e.home, oddsMilli: 2000 }));
    // The default ladder: 3% for 3 legs.
    const before = await place(handle.db, userId, {
      stake: birr(100),
      legs,
      settings: await loadGameSettings(handle.db),
    });
    await handle.db.transaction((tx) =>
      updateMultiBonusSettings(tx, {
        value: ladder({ tiers: [{ minLegs: 3, percentBps: 1_000 }] }),
        actor: admin(),
      }),
    );
    const after = await place(handle.db, userId, {
      stake: birr(100),
      legs,
      settings: await loadGameSettings(handle.db),
    });
    for (const e of events) {
      await finish(handle.db, e.eventId, 1, 0);
      await handle.db.transaction((tx) => settleEventBets(tx, e.eventId, new Date()));
    }
    // 100 × 8 = 800: winnings 700; bonus 3% = 21 (placed before) or 10% = 70 (after);
    // tax 20% of everything above the stake.
    const grossBefore = birr(800) + (birr(700) * 300n) / 10_000n;
    const grossAfter = birr(800) + (birr(700) * 1_000n) / 10_000n;
    const [settledBefore] = await handle.db.select().from(bets).where(eq(bets.id, before.bet.id));
    const [settledAfter] = await handle.db.select().from(bets).where(eq(bets.id, after.bet.id));
    expect(settledBefore).toMatchObject({
      status: 'won',
      bonusPercentBps: 300,
      settledGrossPayout: grossBefore,
      settledTax: ((grossBefore - birr(100)) * 2_000n) / 10_000n,
    });
    expect(settledAfter).toMatchObject({
      status: 'won',
      bonusPercentBps: 1_000,
      settledGrossPayout: grossAfter,
      settledTax: ((grossAfter - birr(100)) * 2_000n) / 10_000n,
    });
  });
});

describe('updateJackpotTemplate', () => {
  it('replaces one template, keeps the other and audits the change', async () => {
    const actor = admin();
    const updated = await handle.db.transaction((tx) =>
      updateJackpotTemplate(tx, { code: 'daily9', value: smallDaily(), actor }),
    );
    expect(updated).toEqual({
      code: 'daily9',
      enabled: true,
      gameCount: 3,
      costPerCombination: birr(10),
      maxCombinations: 8,
      cancelledRule: 'all_win',
      prizeTiers: [
        { correct: 3, kind: 'shared', amount: birr(1_000) },
        { correct: 2, kind: 'fixed', amount: birr(20) },
      ],
    });
    const templates = await getJackpotTemplates(handle.db);
    expect(templates.daily9).toEqual(updated);
    expect(templates.weekly13).toEqual(DEFAULT_JACKPOTS.weekly13);
    const [audit] = await handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'settings.updated'), eq(auditLog.targetId, 'jackpots')));
    expect(audit).toMatchObject({
      actorType: 'admin',
      actorId: actor.id,
      metadata: {
        key: 'jackpots',
        code: 'daily9',
        after: { gameCount: 3, costPerCombination: '1000' },
      },
    });
  });

  it('refuses an invalid template with 422 invalid_setting', async () => {
    const before = await getSetting(handle.db, 'jackpots');
    const cases: Array<[string, unknown]> = [
      ['daily9', smallDaily({ code: 'weekly13' })],
      ['daily9', smallDaily({ prizeTiers: [] })],
      // The first tier must be for every game correct.
      ['daily9', smallDaily({ prizeTiers: [{ correct: 2, kind: 'shared', amount: '100' }] })],
      [
        'daily9',
        smallDaily({
          prizeTiers: [
            { correct: 3, kind: 'shared', amount: '100' },
            { correct: 0, kind: 'fixed', amount: '100' },
          ],
        }),
      ],
      ['daily9', smallDaily({ prizeTiers: [{ correct: 3, kind: 'shared', amount: '0' }] })],
      [
        'daily9',
        smallDaily({
          prizeTiers: [
            { correct: 2, kind: 'fixed', amount: '100' },
            { correct: 3, kind: 'shared', amount: '100' },
          ],
        }),
      ],
      ['daily9', smallDaily({ maxCombinations: 2_000_000 })],
      ['daily9', smallDaily({ costPerCombination: '0' })],
      ['daily9', smallDaily({ gameCount: 0 })],
      ['daily9', smallDaily({ cancelledRule: 'refund' })],
      ['daily9', smallDaily({ enabled: undefined })],
    ];
    for (const [code, value] of cases) {
      const error = await domainError(
        handle.db.transaction((tx) =>
          updateJackpotTemplate(tx, { code: code as 'daily9', value, actor: admin() }),
        ),
      );
      expect(error).toMatchObject({ status: 422, code: 'invalid_setting' });
    }
    expect(await getSetting(handle.db, 'jackpots')).toEqual(before);
  });

  it('applies to rounds opened after the change only', async () => {
    await handle.db.transaction((tx) =>
      updateJackpotTemplate(tx, { code: 'daily9', value: smallDaily(), actor: admin() }),
    );
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + HOUR));
    const settings = await loadGameSettings(handle.db);
    const round = await handle.db.transaction((tx) =>
      createJackpotRound(tx, {
        template: settings.jackpots.daily9,
        tax: settings.tax,
        eventIds: games.map((g) => g.eventId),
        now: new Date(),
      }),
    );
    // Dearer combinations and a bigger pool from now on.
    await handle.db.transaction((tx) =>
      updateJackpotTemplate(tx, {
        code: 'daily9',
        value: smallDaily({
          costPerCombination: '2000',
          prizeTiers: [
            { correct: 3, kind: 'shared', amount: '500000' },
            { correct: 2, kind: 'fixed', amount: '2000' },
          ],
        }),
        actor: admin(),
      }),
    );
    const userId = await createUser(handle.db);
    await fund(handle.db, userId, birr(100));
    const { entry } = await enter(handle.db, userId, round.id, [['1'], ['1'], ['1']]);
    // The open round keeps its own price and pool.
    expect(entry.cost).toBe(birr(10));
    for (const game of games) await resultGame(handle.db, game, '1');
    await settle(handle.db, round.id);
    const pool = birr(1_000);
    const tax = ((pool - birr(10)) * BigInt(DEFAULT_TAX.rateBps)) / 10_000n;
    expect(await cashOf(handle.db, userId)).toBe(birr(100) - birr(10) + pool - tax);

    const next = await createGames(handle.db, ids, 3, new Date(Date.now() + 2 * HOUR));
    const fresh = await loadGameSettings(handle.db);
    const newer = await handle.db.transaction((tx) =>
      createJackpotRound(tx, {
        template: fresh.jackpots.daily9,
        tax: fresh.tax,
        eventIds: next.map((g) => g.eventId),
        now: new Date(),
      }),
    );
    expect(newer).toMatchObject({ costPerCombination: birr(20), pool: birr(5_000) });
  });
});

describe('getPromotions', () => {
  it('shows the ladder in force and the rounds taking entries', async () => {
    const games = await createGames(handle.db, ids, 3, new Date(Date.now() + 3 * HOUR));
    const settings = await loadGameSettings(handle.db);
    const round = await handle.db.transaction((tx) =>
      createJackpotRound(tx, {
        template: settings.jackpots.daily9,
        tax: settings.tax,
        eventIds: games.map((g) => g.eventId),
        now: new Date(),
      }),
    );
    const promotions = await getPromotions(handle.db, new Date());
    expect(promotions.multiBonus).toEqual(settings.multiBonus);
    expect(promotions.jackpots.map((r) => r.id)).toContain(round.id);
    expect(promotions.jackpots.every((r) => r.status === 'open')).toBe(true);
  });
});

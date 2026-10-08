import { describe, expect, it } from 'vitest';
import { birr } from './money';
import {
  DEFAULT_BET_RULES,
  DEFAULT_CASH_OUT,
  DEFAULT_JACKPOTS,
  DEFAULT_LIVE_BET_DELAY_MS,
  DEFAULT_MULTI_BONUS,
  DEFAULT_RESPONSIBLE_GAMBLING,
  DEFAULT_TAX,
} from './rules';

// These defaults set customer payouts and compliance limits. A change here must be a
// deliberate policy change (confirmed with counsel), so every value is pinned.

describe('DEFAULT_MULTI_BONUS', () => {
  it('pins the default multi-bonus ladder', () => {
    expect(DEFAULT_MULTI_BONUS.tiers).toEqual([
      { minLegs: 3, percentBps: 300 },
      { minLegs: 4, percentBps: 500 },
      { minLegs: 5, percentBps: 800 },
      { minLegs: 6, percentBps: 1_000 },
      { minLegs: 7, percentBps: 1_500 },
      { minLegs: 8, percentBps: 2_000 },
      { minLegs: 9, percentBps: 2_500 },
      { minLegs: 10, percentBps: 3_000 },
      { minLegs: 12, percentBps: 4_000 },
      { minLegs: 15, percentBps: 5_000 },
      { minLegs: 20, percentBps: 10_000 },
      { minLegs: 25, percentBps: 15_000 },
      { minLegs: 30, percentBps: 20_000 },
    ]);
  });

  it('pins the bonus switches and limits', () => {
    expect(DEFAULT_MULTI_BONUS.enabled).toBe(true);
    expect(DEFAULT_MULTI_BONUS.minLegOddsMilli).toBe(1300);
    expect(DEFAULT_MULTI_BONUS.maxBonus).toBe(birr(50_000));
  });

  it('is a well-formed ladder: minLegs strictly ascending, rates non-decreasing', () => {
    const { tiers } = DEFAULT_MULTI_BONUS;
    expect(tiers.length).toBeGreaterThan(0);
    for (const [i, tier] of tiers.entries()) {
      expect(Number.isSafeInteger(tier.minLegs), `tier ${i} minLegs`).toBe(true);
      expect(Number.isSafeInteger(tier.percentBps), `tier ${i} percentBps`).toBe(true);
      expect(tier.percentBps).toBeGreaterThan(0);
      const prev = tiers[i - 1];
      if (prev !== undefined) {
        expect(tier.minLegs, `tier ${i} minLegs`).toBeGreaterThan(prev.minLegs);
        expect(tier.percentBps, `tier ${i} percentBps`).toBeGreaterThanOrEqual(prev.percentBps);
      }
    }
  });

  it('only has tiers a placeable multi can reach', () => {
    const { tiers, minLegOddsMilli } = DEFAULT_MULTI_BONUS;
    // Singles never get a bonus, so a tier below 2 legs would be dead config.
    expect(Math.min(...tiers.map((t) => t.minLegs))).toBeGreaterThanOrEqual(2);
    expect(Math.max(...tiers.map((t) => t.minLegs))).toBeLessThanOrEqual(DEFAULT_BET_RULES.maxLegs);
    expect(minLegOddsMilli).toBeGreaterThanOrEqual(DEFAULT_BET_RULES.minLegOddsMilli);
  });
});

describe('policy defaults', () => {
  it('pins the responsible-gambling minimum age at 21', () => {
    expect(DEFAULT_RESPONSIBLE_GAMBLING).toEqual({ minAge: 21 });
  });

  it('pins the bet rules', () => {
    expect(DEFAULT_BET_RULES).toEqual({
      minStake: birr(5),
      maxStake: birr(100_000),
      maxPayout: birr(500_000),
      maxLegs: 40,
      minLegOddsMilli: 1010,
      maxTotalOddsMilli: 1_000_000_000n,
    });
  });

  it('pins the winnings tax placeholder', () => {
    expect(DEFAULT_TAX).toEqual({ rateBps: 2_000, base: 'net_winnings', exemptBelow: birr(100) });
  });

  it('pins cash-out and the live bet delay', () => {
    expect(DEFAULT_CASH_OUT).toEqual({ enabled: true, marginBps: 500, minOffer: birr(1) });
    expect(DEFAULT_LIVE_BET_DELAY_MS).toBe(6_000);
  });
});

describe('DEFAULT_JACKPOTS', () => {
  it('pins the daily 9 template', () => {
    expect(DEFAULT_JACKPOTS.daily9.maxCombinations).toBe(1_024);
    expect(DEFAULT_JACKPOTS.daily9).toEqual({
      code: 'daily9',
      gameCount: 9,
      costPerCombination: birr(10),
      maxCombinations: 1_024,
      cancelledRule: 'all_win',
      prizeTiers: [
        { correct: 9, kind: 'shared', amount: birr(100_000) },
        { correct: 8, kind: 'fixed', amount: birr(200) },
      ],
    });
  });

  it('pins the weekly 13 template', () => {
    expect(DEFAULT_JACKPOTS.weekly13).toEqual({
      code: 'weekly13',
      gameCount: 13,
      costPerCombination: birr(10),
      maxCombinations: 4_096,
      cancelledRule: 'all_win',
      prizeTiers: [
        { correct: 13, kind: 'shared', amount: birr(1_000_000) },
        { correct: 12, kind: 'shared', amount: birr(100_000) },
        { correct: 11, kind: 'fixed', amount: birr(500) },
        { correct: 10, kind: 'fixed', amount: birr(50) },
      ],
    });
  });

  it('has only the two templates, each keyed by its own code', () => {
    expect(Object.keys(DEFAULT_JACKPOTS).sort()).toEqual(['daily9', 'weekly13']);
    for (const [key, template] of Object.entries(DEFAULT_JACKPOTS)) {
      expect(template.code).toBe(key);
    }
  });

  it.each(Object.values(DEFAULT_JACKPOTS))(
    '$code has well-formed prize tiers and limits',
    (template) => {
      expect(Number.isSafeInteger(template.gameCount)).toBe(true);
      expect(template.gameCount).toBeGreaterThan(0);
      expect(Number.isSafeInteger(template.maxCombinations)).toBe(true);
      expect(template.maxCombinations).toBeGreaterThanOrEqual(1);
      expect(template.costPerCombination > 0n).toBe(true);

      const { prizeTiers } = template;
      expect(prizeTiers.length).toBeGreaterThan(0);
      // The top prize is for getting every game right.
      expect(prizeTiers[0]?.correct).toBe(template.gameCount);
      for (const [i, tier] of prizeTiers.entries()) {
        expect(Number.isSafeInteger(tier.correct), `tier ${i}`).toBe(true);
        expect(tier.correct, `tier ${i}`).toBeGreaterThan(0);
        expect(tier.correct, `tier ${i}`).toBeLessThanOrEqual(template.gameCount);
        expect(tier.amount > 0n, `tier ${i} amount`).toBe(true);
        const prev = prizeTiers[i - 1];
        // Strictly descending `correct`, which also makes it unique.
        if (prev !== undefined) expect(tier.correct, `tier ${i}`).toBeLessThan(prev.correct);
      }
    },
  );
});

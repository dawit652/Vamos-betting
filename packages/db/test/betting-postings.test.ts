import { randomUUID } from 'node:crypto';
import { DEFAULT_MULTI_BONUS, settleBet, type LegState, type TaxConfig } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  accountKey,
  negateEntries,
  refundEntries,
  settlementPosting,
  stakeEntries,
  type PostingEntry,
} from '../src/index';
import { normalizePosting } from '../src/ledger/post';

const userId = randomUUID();

function byKey(entries: PostingEntry[]): Record<string, bigint> {
  return Object.fromEntries(entries.map((e) => [accountKey(e.account), e.amount]));
}

describe('betting postings', () => {
  it('stake and refund move the stake between the player and house_stakes', () => {
    expect(byKey(stakeEntries(userId, 500n))).toEqual({
      [`user:${userId}:cash`]: -500n,
      'house:stakes': 500n,
    });
    expect(byKey(refundEntries(userId, 500n))).toEqual({
      'house:stakes': -500n,
      [`user:${userId}:cash`]: 500n,
    });
  });

  it('won: net to the player, tax to tax payable, the winnings out of revenue', () => {
    const posting = settlementPosting(userId, 10_000n, {
      status: 'won',
      grossPayout: 20_000n,
      taxAmount: 2_000n,
      netPayout: 18_000n,
    });
    expect(posting.type).toBe('bet_payout');
    expect(byKey(posting.entries)).toEqual({
      [`user:${userId}:cash`]: 18_000n,
      'house:tax_payable': 2_000n,
      'house:stakes': -10_000n,
      'house:revenue': -10_000n,
    });
  });

  it('won without tax or winnings leaves the zero entries out', () => {
    const posting = settlementPosting(userId, 500n, {
      status: 'won',
      grossPayout: 500n,
      taxAmount: 0n,
      netPayout: 500n,
    });
    expect(byKey(posting.entries)).toEqual({
      [`user:${userId}:cash`]: 500n,
      'house:stakes': -500n,
    });
  });

  it('lost: the stake moves from house_stakes to house_revenue as a bet_payout', () => {
    const posting = settlementPosting(userId, 700n, {
      status: 'lost',
      grossPayout: 0n,
      taxAmount: 0n,
      netPayout: 0n,
    });
    expect(posting.type).toBe('bet_payout');
    expect(byKey(posting.entries)).toEqual({ 'house:stakes': -700n, 'house:revenue': 700n });
  });

  it('void: a bet_refund of the stake', () => {
    const posting = settlementPosting(userId, 700n, {
      status: 'void',
      grossPayout: 700n,
      taxAmount: 0n,
      netPayout: 700n,
    });
    expect(posting.type).toBe('bet_refund');
    expect(byKey(posting.entries)).toEqual({
      'house:stakes': -700n,
      [`user:${userId}:cash`]: 700n,
    });
  });

  it('refuses amounts that do not add up', () => {
    const won = { status: 'won' as const, grossPayout: 2000n, taxAmount: 0n, netPayout: 2000n };
    expect(() => settlementPosting(userId, 0n, won)).toThrow(RangeError);
    expect(() => settlementPosting(userId, 1000n, { ...won, netPayout: 1999n })).toThrow(
      RangeError,
    );
    expect(() => settlementPosting(userId, 3000n, won)).toThrow(RangeError);
    expect(() => settlementPosting(userId, 1000n, { ...won, status: 'lost' })).toThrow(RangeError);
    expect(() => settlementPosting(userId, 1000n, { ...won, status: 'void' })).toThrow(RangeError);
  });

  describe('properties (settlements from core settleBet)', () => {
    const legState = fc.constantFrom<LegState>('won', 'lost', 'void');
    const leg = fc.record({ oddsMilli: fc.integer({ min: 1001, max: 50_000 }), state: legState });
    const tax: fc.Arbitrary<TaxConfig> = fc.record({
      rateBps: fc.integer({ min: 0, max: 5000 }),
      base: fc.constantFrom('net_winnings' as const, 'gross_payout' as const),
      exemptBelow: fc.bigInt({ min: 0n, max: 100_000n }),
    });
    // The bet rules guarantee maxStake <= maxPayout (BetRulesSchema, see settings.test.ts),
    // so every bet's cap is at least its stake: generated that way, not filtered.
    const settlement = fc
      .record({
        stake: fc.bigInt({ min: 1n, max: 10_000_000n }),
        legs: fc.array(leg, { minLength: 1, maxLength: 12 }),
        capAboveStake: fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        tax,
      })
      .map(({ stake, legs, capAboveStake, tax }) => ({
        stake,
        result: settleBet({
          stake,
          legs,
          maxPayout: stake + capAboveStake,
          multiBonus: DEFAULT_MULTI_BONUS,
          tax,
        }),
      }));

    it('balances, has no zero entries, pays the player net and keeps house_stakes whole', () => {
      fc.assert(
        fc.property(settlement, ({ stake, result }) => {
          if (result.status === 'won') expect(result.grossPayout).toBeGreaterThanOrEqual(stake);
          const posting = settlementPosting(userId, stake, result);
          expect(() =>
            normalizePosting({ type: posting.type, idempotencyKey: 'k', entries: posting.entries }),
          ).not.toThrow();
          const amounts = byKey(posting.entries);
          expect(posting.entries.every((e) => e.amount !== 0n)).toBe(true);
          expect(posting.entries.reduce((sum, e) => sum + e.amount, 0n)).toBe(0n);
          expect(amounts['house:stakes']).toBe(-stake);
          expect(amounts[`user:${userId}:cash`] ?? 0n).toBe(result.netPayout);
          expect(amounts['house:tax_payable'] ?? 0n).toBe(result.taxAmount);
          expect(amounts['house:revenue'] ?? 0n).toBe(stake - result.grossPayout);
        }),
      );
    });

    it('the negation of a settlement exactly cancels it', () => {
      fc.assert(
        fc.property(settlement, ({ stake, result }) => {
          const { entries } = settlementPosting(userId, stake, result);
          const total = new Map<string, bigint>();
          for (const e of [...entries, ...negateEntries(entries)]) {
            const key = accountKey(e.account);
            total.set(key, (total.get(key) ?? 0n) + e.amount);
          }
          expect([...total.values()].every((v) => v === 0n)).toBe(true);
        }),
      );
    });
  });
});

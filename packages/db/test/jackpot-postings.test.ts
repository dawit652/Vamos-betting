import { randomUUID } from 'node:crypto';
import { birr } from '@vamos/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalPicks,
  catalogueGameResult,
  jackpotEntryEntries,
  jackpotEntryLedgerKey,
  jackpotPrizeEntries,
  jackpotPrizeLedgerKey,
  jackpotRefundEntries,
  jackpotRefundLedgerKey,
  type GameResultSource,
} from '../src/index';

const USER = randomUUID();
const sum = (entries: Array<{ amount: bigint }>) => entries.reduce((s, e) => s + e.amount, 0n);

describe('jackpot postings', () => {
  it('an entry moves its cost from the player to house_jackpot; a refund moves it back', () => {
    expect(jackpotEntryEntries(USER, birr(30))).toEqual([
      { account: { kind: 'player_cash', userId: USER }, amount: -birr(30) },
      { account: { kind: 'house_jackpot' }, amount: birr(30) },
    ]);
    expect(jackpotRefundEntries(USER, birr(30))).toEqual([
      { account: { kind: 'house_jackpot' }, amount: -birr(30) },
      { account: { kind: 'player_cash', userId: USER }, amount: birr(30) },
    ]);
    expect(() => jackpotEntryEntries(USER, 0n)).toThrow(RangeError);
    expect(() => jackpotRefundEntries(USER, -1n)).toThrow(RangeError);
  });

  it('a prize pays the net to the player and the tax to house_tax_payable, leaving out a zero tax', () => {
    expect(jackpotPrizeEntries(USER, { gross: birr(500), tax: birr(98), net: birr(402) })).toEqual([
      { account: { kind: 'house_jackpot' }, amount: -birr(500) },
      { account: { kind: 'player_cash', userId: USER }, amount: birr(402) },
      { account: { kind: 'house_tax_payable' }, amount: birr(98) },
    ]);
    expect(jackpotPrizeEntries(USER, { gross: birr(40), tax: 0n, net: birr(40) })).toHaveLength(2);
    for (const bad of [
      { gross: 0n, tax: 0n, net: 0n },
      { gross: birr(10), tax: birr(5), net: birr(4) },
      { gross: birr(10), tax: -1n, net: birr(10) + 1n },
      { gross: birr(10), tax: birr(10), net: 0n },
    ]) {
      expect(() => jackpotPrizeEntries(USER, bad)).toThrow(RangeError);
    }
  });

  it('every posting balances (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: birr(1_000_000) }),
        fc.bigInt({ min: 0n, max: birr(1_000_000) }),
        (net, tax) => {
          expect(sum(jackpotPrizeEntries(USER, { gross: net + tax, tax, net }))).toBe(0n);
          expect(sum(jackpotEntryEntries(USER, net))).toBe(0n);
          expect(sum(jackpotRefundEntries(USER, net))).toBe(0n);
        },
      ),
    );
  });

  it('uses one ledger key per entry payment, prize and refund', () => {
    expect(jackpotEntryLedgerKey(USER, 'client-key-1')).toBe(`jackpot_entry:${USER}:client-key-1`);
    expect(jackpotPrizeLedgerKey('e1')).toBe('jackpot_prize:e1');
    expect(jackpotRefundLedgerKey('e1')).toBe('jackpot_refund:e1');
  });
});

describe('canonicalPicks', () => {
  it('orders each game’s picks 1, X, 2 and keeps anything else for validation', () => {
    expect(canonicalPicks([['2', 'X', '1'], ['X'], ['2', '1']])).toEqual([
      ['1', 'X', '2'],
      ['X'],
      ['1', '2'],
    ]);
    expect(canonicalPicks([['Z', '2', 'A']])).toEqual([['2', 'A', 'Z']]);
    expect(canonicalPicks([['1', '1']])).toEqual([['1', '1']]);
  });

  it('is null for anything but an array of arrays of strings of sane size', () => {
    for (const bad of [
      'picks',
      null,
      [['1'], '2'],
      [[1]],
      Array.from({ length: 65 }, () => ['1']),
      [Array.from({ length: 9 }, () => '1')],
    ]) {
      expect(canonicalPicks(bad)).toBeNull();
    }
  });
});

describe('catalogueGameResult', () => {
  const source = (
    marketStatus: GameResultSource['marketStatus'],
    one: 'won' | 'lost' | 'void' | null,
    draw: 'won' | 'lost' | 'void' | null,
    two: 'won' | 'lost' | 'void' | null,
  ): GameResultSource => ({ marketStatus, results: { '1': one, X: draw, '2': two } });

  it('reads the winning outcome of a settled 1X2 market', () => {
    expect(catalogueGameResult(source('settled', 'won', 'lost', 'lost'))).toBe('1');
    expect(catalogueGameResult(source('settled', 'lost', 'won', 'lost'))).toBe('X');
    expect(catalogueGameResult(source('settled', 'lost', 'lost', 'won'))).toBe('2');
  });

  it('is cancelled for a void market or all-void selections', () => {
    expect(catalogueGameResult(source('void', 'void', 'void', 'void'))).toBe('cancelled');
    expect(catalogueGameResult(source('void', null, null, null))).toBe('cancelled');
    expect(catalogueGameResult(source('settled', 'void', 'void', 'void'))).toBe('cancelled');
  });

  it('waits (null) while unresulted or when the results do not add up', () => {
    for (const status of ['open', 'suspended', 'closed'] as const) {
      expect(catalogueGameResult(source(status, null, null, null))).toBeNull();
    }
    expect(catalogueGameResult(source('settled', 'won', 'won', 'lost'))).toBeNull();
    expect(catalogueGameResult(source('settled', 'won', 'lost', null))).toBeNull();
    expect(catalogueGameResult(source('settled', 'lost', 'lost', 'lost'))).toBeNull();
    expect(catalogueGameResult(source('settled', 'won', 'void', 'lost'))).toBeNull();
  });
});

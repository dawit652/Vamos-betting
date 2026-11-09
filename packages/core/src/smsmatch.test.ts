import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_SANTIM_OFFSET,
  allocateSmsAmount,
  SMS_HANDSET_CLOCK_SKEW_MS,
  SMS_INSTITUTION_CLOCK_SKEW_MS,
  matchSmsDeposit,
  proposePayoutForSms,
  smsPaidBy,
  type ManualPayoutCandidate,
  type OpenSmsDeposit,
} from './smsmatch';

const NOW = new Date('2026-09-01T10:00:00Z');
const LATER = new Date(NOW.getTime() + 60_000);

function deposit(o: Partial<OpenSmsDeposit> = {}): OpenSmsDeposit {
  return {
    intentId: 'i1',
    userId: 'u1',
    amount: 10037n,
    phone: '+251900000000',
    expiresAt: LATER,
    ...o,
  };
}

const credit = { direction: 'credit' as const, amount: 10037n, counterpartyPhone: '+251900000000' };

describe('matchSmsDeposit', () => {
  it('matches on the unique amount and the phone', () => {
    expect(matchSmsDeposit(credit, [deposit()], NOW)).toEqual({
      type: 'matched',
      intentId: 'i1',
      userId: 'u1',
      confidence: 'amount_and_phone',
      received: 10037n,
      amountDiffers: false,
    });
  });

  it('matches on the amount alone when the phone is someone else', () => {
    expect(matchSmsDeposit(credit, [deposit({ phone: '+251911111111' })], NOW)).toMatchObject({
      type: 'matched',
      confidence: 'exact_amount',
    });
  });

  it('never matches a debit', () => {
    expect(matchSmsDeposit({ ...credit, direction: 'debit' }, [deposit()], NOW)).toEqual({
      type: 'unmatched',
      reason: 'not_a_credit',
    });
  });

  it('ignores expired deposits', () => {
    expect(matchSmsDeposit(credit, [deposit({ expiresAt: NOW })], NOW)).toEqual({
      type: 'unmatched',
      reason: 'no_open_deposit',
    });
  });

  it('falls back to the phone when the player sends the round number, flagging the difference', () => {
    expect(matchSmsDeposit({ ...credit, amount: 10000n }, [deposit()], NOW)).toMatchObject({
      type: 'matched',
      confidence: 'phone_fallback',
      received: 10000n,
      amountDiffers: true,
    });
  });

  it('refuses to guess between two deposits on one phone', () => {
    const open = [deposit({ intentId: 'a' }), deposit({ intentId: 'b', amount: 20055n })];
    expect(matchSmsDeposit({ ...credit, amount: 10000n }, open, NOW)).toEqual({
      type: 'ambiguous',
      intentIds: ['a', 'b'],
    });
  });

  it('refuses to guess between two deposits of the same amount', () => {
    const open = [deposit({ intentId: 'a' }), deposit({ intentId: 'b', userId: 'u2' })];
    expect(matchSmsDeposit(credit, open, NOW).type).toBe('ambiguous');
  });

  it('leaves an unknown payment for review', () => {
    expect(
      matchSmsDeposit(
        { ...credit, amount: 77777n, counterpartyPhone: '+251999999999' },
        [deposit()],
        NOW,
      ),
    ).toEqual({ type: 'unmatched', reason: 'no_amount_or_phone_match' });
  });

  it('only ever matches a live deposit, credits what arrived, and never matches a debit', () => {
    const open = fc.array(
      fc.record({
        intentId: fc.uuid(),
        userId: fc.uuid(),
        amount: fc.bigInt({ min: 101n, max: 200n }),
        phone: fc.option(fc.constantFrom('+251900000001', '+251900000002', '+251900000003')),
        expiresAt: fc.date({
          min: new Date(NOW.getTime() - 1000),
          max: new Date(NOW.getTime() + 1000),
          noInvalidDate: true,
        }),
      }),
      { maxLength: 8 },
    );
    const sms = fc.record({
      direction: fc.constantFrom('credit' as const, 'debit' as const),
      amount: fc.bigInt({ min: 101n, max: 200n }),
      counterpartyPhone: fc.option(fc.constantFrom('+251900000001', '+251900000002')),
    });
    fc.assert(
      fc.property(sms, open, (message, deposits) => {
        const result = matchSmsDeposit(message, deposits, NOW);
        if (message.direction === 'debit') return result.type === 'unmatched';
        if (result.type !== 'matched') return true;
        const target = deposits.find((d) => d.intentId === result.intentId);
        return (
          target !== undefined &&
          target.expiresAt.getTime() > NOW.getTime() &&
          result.received === message.amount &&
          result.amountDiffers === (target.amount !== message.amount)
        );
      }),
    );
  });
});

describe('allocateSmsAmount', () => {
  it('skips amounts already in flight', () => {
    expect(allocateSmsAmount(10000n, new Set([10001n, 10002n, 10003n]), () => 1)).toBe(10004n);
  });

  it('wraps around the offset range', () => {
    const top = 10000n + BigInt(MAX_SANTIM_OFFSET);
    expect(allocateSmsAmount(10000n, new Set([top]), () => MAX_SANTIM_OFFSET)).toBe(10001n);
  });

  it('returns null instead of colliding when the space is full', () => {
    const full = new Set(
      Array.from({ length: MAX_SANTIM_OFFSET }, (_, i) => 10000n + BigInt(i + 1)),
    );
    expect(allocateSmsAmount(10000n, full, () => 1)).toBeNull();
  });

  it('refuses a bad base or offset', () => {
    expect(() => allocateSmsAmount(0n, new Set(), () => 1)).toThrow(RangeError);
    expect(() => allocateSmsAmount(100n, new Set(), () => 0)).toThrow(RangeError);
    expect(() => allocateSmsAmount(100n, new Set(), () => MAX_SANTIM_OFFSET + 1)).toThrow(
      RangeError,
    );
  });

  it('never collides and stays within 1..MAX_SANTIM_OFFSET santim above the base', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 100n, max: 10n ** 9n }),
        fc.integer({ min: 1, max: MAX_SANTIM_OFFSET }),
        fc.uniqueArray(fc.integer({ min: 1, max: MAX_SANTIM_OFFSET }), {
          maxLength: MAX_SANTIM_OFFSET,
        }),
        (base, start, takenOffsets) => {
          const taken = new Set(takenOffsets.map((o) => base + BigInt(o)));
          const amount = allocateSmsAmount(base, taken, () => start);
          if (takenOffsets.length === MAX_SANTIM_OFFSET) return amount === null;
          return (
            amount !== null &&
            !taken.has(amount) &&
            amount > base &&
            amount <= base + BigInt(MAX_SANTIM_OFFSET)
          );
        },
      ),
    );
  });
});

describe('proposePayoutForSms', () => {
  const debit = { direction: 'debit' as const, amount: 50000n, counterpartyPhone: '+251911678426' };
  const payout = (o: Partial<ManualPayoutCandidate> = {}): ManualPayoutCandidate => ({
    payoutId: 'p1',
    amount: 50000n,
    destinationAccount: '+251911678426',
    ...o,
  });

  it('proposes when amount and destination agree', () => {
    expect(proposePayoutForSms(debit, [payout()])).toEqual({
      type: 'proposed',
      payoutId: 'p1',
      confidence: 'amount_and_account',
    });
  });

  it('never proposes for a credit', () => {
    expect(proposePayoutForSms({ ...debit, direction: 'credit' }, [payout()])).toEqual({
      type: 'none',
      reason: 'not_a_debit',
    });
  });

  it('refuses when the amount matches but the money went elsewhere', () => {
    expect(
      proposePayoutForSms({ ...debit, counterpartyPhone: '+251977000111' }, [payout()]),
    ).toEqual({
      type: 'none',
      reason: 'no_candidate',
    });
  });

  it('refuses to choose between two identical payouts', () => {
    expect(proposePayoutForSms(debit, [payout(), payout({ payoutId: 'p2' })])).toEqual({
      type: 'ambiguous',
    });
  });

  it('falls back to the amount alone only when it is decisive', () => {
    const anonymous = { ...debit, counterpartyPhone: null };
    expect(proposePayoutForSms(anonymous, [payout()])).toMatchObject({ confidence: 'amount_only' });
    expect(
      proposePayoutForSms(anonymous, [
        payout(),
        payout({ payoutId: 'p2', destinationAccount: '+251922222222' }),
      ]),
    ).toEqual({ type: 'ambiguous' });
  });

  it('only ever proposes a payout of the same amount, to the named destination when there is one', () => {
    const candidates = fc.uniqueArray(
      fc.record({
        payoutId: fc.uuid(),
        amount: fc.constantFrom(100n, 200n),
        destinationAccount: fc.constantFrom('+251900000001', '+251900000002'),
      }),
      { selector: (c) => c.payoutId, maxLength: 6 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(100n, 200n, 300n),
        fc.option(fc.constantFrom('+251900000001', '+251900000002')),
        candidates,
        (amount, phone, list) => {
          const result = proposePayoutForSms(
            { direction: 'debit', amount, counterpartyPhone: phone },
            list,
          );
          if (result.type !== 'proposed') return true;
          const chosen = list.find((c) => c.payoutId === result.payoutId)!;
          return (
            chosen.amount === amount && (phone === null || chosen.destinationAccount === phone)
          );
        },
      ),
    );
  });
});

describe('smsPaidBy', () => {
  const now = new Date('2026-08-15T18:00:00Z'); // 21:00 EAT

  it('is the institution time plus skew, or the end of its day for a date without a time', () => {
    const at = new Date('2026-08-15T12:31:00Z'); // 15:31 EAT
    expect(smsPaidBy({ occurredAt: at, deviceReceivedAt: null, now })).toEqual(
      new Date(at.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS),
    );
    const midnightEat = new Date('2026-08-14T21:00:00Z'); // "on 15/08/2026"
    expect(smsPaidBy({ occurredAt: midnightEat, deviceReceivedAt: null, now })).toEqual(now);
    const yesterday = new Date('2026-08-13T21:00:00Z'); // "on 14/08/2026"
    expect(smsPaidBy({ occurredAt: yesterday, deviceReceivedAt: null, now })).toEqual(
      new Date('2026-08-14T21:05:00Z'),
    );
  });

  it('uses the handset receive time, and ignores times in our future', () => {
    const device = new Date('2026-08-15T14:00:00Z');
    expect(smsPaidBy({ occurredAt: null, deviceReceivedAt: device, now })).toEqual(
      new Date(device.getTime() + SMS_HANDSET_CLOCK_SKEW_MS),
    );
    const future = new Date(now.getTime() + 2 * 60 * 60_000);
    expect(smsPaidBy({ occurredAt: future, deviceReceivedAt: future, now })).toEqual(now);
    expect(smsPaidBy({ occurredAt: null, deviceReceivedAt: null, now })).toEqual(now);
  });

  it('is never after now, nor before the earliest time given plus its skew', () => {
    const time = fc.date({
      min: new Date('2026-01-01T00:00:00Z'),
      max: new Date('2027-01-01T00:00:00Z'),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(fc.option(time), fc.option(time), time, (occurredAt, deviceReceivedAt, at) => {
        const bound = smsPaidBy({ occurredAt, deviceReceivedAt, now: at }).getTime();
        expect(bound).toBeLessThanOrEqual(at.getTime());
        const floors = [at.getTime()];
        if (occurredAt !== null) floors.push(occurredAt.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS);
        if (deviceReceivedAt !== null) {
          floors.push(deviceReceivedAt.getTime() + SMS_HANDSET_CLOCK_SKEW_MS);
        }
        expect(bound).toBeGreaterThanOrEqual(Math.min(...floors));
      }),
    );
  });
});

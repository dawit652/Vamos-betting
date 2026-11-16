import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_SANTIM_OFFSET,
  allocateSmsAmount,
  latestClaimForSms,
  SMS_HANDSET_CLOCK_SKEW_MS,
  SMS_INSTITUTION_CLOCK_SKEW_MS,
  matchSmsDeposit,
  proposePayoutForSms,
  smsPaidBy,
  takenAmounts,
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

  it('offers 99 amounts above a whole-birr request, all with its birr figure', () => {
    expect(MAX_SANTIM_OFFSET).toBe(99);
    const taken = new Set<bigint>();
    for (let i = 0; i < MAX_SANTIM_OFFSET; i++) {
      const amount = allocateSmsAmount(10000n, taken, () => 1);
      expect(amount).not.toBeNull();
      taken.add(amount!);
    }
    expect(taken.size).toBe(99);
    expect([...taken].every((amount) => amount / 100n === 100n && amount % 100n !== 0n)).toBe(true);
    expect(allocateSmsAmount(10000n, taken, () => 1)).toBeNull();
  });

  it('never reserves a whole-birr amount, which another payer might send by chance', () => {
    // 100.01 + 99 santim would be 101.00: skipped, the next free amount is taken instead.
    expect(allocateSmsAmount(10001n, new Set(), () => 99)).toBe(10002n);
    // 100.50 + 50 santim would be 101.00.
    expect(allocateSmsAmount(10050n, new Set(), () => 50)).toBe(10101n);
    // With every other offset taken there is nothing left: refused, not 101.00.
    const others = new Set(
      Array.from({ length: MAX_SANTIM_OFFSET }, (_, i) => 10001n + BigInt(i + 1)).filter(
        (amount) => amount !== 10100n,
      ),
    );
    expect(allocateSmsAmount(10001n, others, () => 1)).toBeNull();
  });

  it('never collides, never lands on a whole birr, and stays within the offset range', () => {
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
          // Usable offsets: 1..MAX whose amount is not a whole birr and not taken.
          const usable = Array.from(
            { length: MAX_SANTIM_OFFSET },
            (_, i) => base + BigInt(i + 1),
          ).filter((candidate) => candidate % 100n !== 0n && !taken.has(candidate));
          if (usable.length === 0) return amount === null;
          return (
            amount !== null &&
            !taken.has(amount) &&
            amount % 100n !== 0n &&
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

describe('latestClaimForSms', () => {
  const receivedAt = new Date('2026-08-15T13:00:00Z'); // 16:00 EAT
  const minutes = (n: number) => n * 60_000;

  it('allows a claim up to the skew after our receive time, and no later', () => {
    const latest = latestClaimForSms({ occurredAt: null, deviceReceivedAt: null, receivedAt });
    expect(latest).toEqual(new Date(receivedAt.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS));
  });

  it('refuses a claim made after the institution says the money moved', () => {
    const occurredAt = new Date(receivedAt.getTime() - minutes(60)); // sent an hour before
    const latest = latestClaimForSms({ occurredAt, deviceReceivedAt: null, receivedAt });
    expect(latest).toEqual(new Date(occurredAt.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS));
    expect(latest.getTime()).toBeLessThan(receivedAt.getTime());
  });

  it('gives a date without a time the whole day, and the handset its larger skew', () => {
    const dayOnly = new Date('2026-08-14T21:00:00Z'); // "on 15/08/2026"
    expect(latestClaimForSms({ occurredAt: dayOnly, deviceReceivedAt: null, receivedAt })).toEqual(
      new Date(receivedAt.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS),
    );
    const device = new Date(receivedAt.getTime() - minutes(90));
    expect(latestClaimForSms({ occurredAt: null, deviceReceivedAt: device, receivedAt })).toEqual(
      new Date(device.getTime() + SMS_HANDSET_CLOCK_SKEW_MS),
    );
  });

  it('never lets a claim after receipt plus skew, or after any clock plus its skew, pass', () => {
    const time = fc.date({
      min: new Date('2026-01-01T00:00:00Z'),
      max: new Date('2027-01-01T00:00:00Z'),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(
        fc.option(time),
        fc.option(time),
        time,
        time,
        (occurredAt, deviceReceivedAt, received, claimedAt) => {
          const latest = latestClaimForSms({ occurredAt, deviceReceivedAt, receivedAt: received });
          if (claimedAt.getTime() > latest.getTime()) return;
          // A claim that passes is no later than our receive time plus the skew ...
          expect(claimedAt.getTime()).toBeLessThanOrEqual(
            received.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS,
          );
          // ... nor than a handset time (not in our future) plus the handset skew.
          if (
            deviceReceivedAt !== null &&
            deviceReceivedAt.getTime() <= received.getTime() + SMS_INSTITUTION_CLOCK_SKEW_MS
          ) {
            expect(claimedAt.getTime()).toBeLessThanOrEqual(
              deviceReceivedAt.getTime() + SMS_HANDSET_CLOCK_SKEW_MS,
            );
          }
        },
      ),
    );
  });
});

describe('collection accounts', () => {
  const onA = { ...credit, collectionAccountId: 'A' };
  const dep = (o: Partial<OpenSmsDeposit>) => deposit(o);

  it('matches a deposit of the account the SMS arrived on', () => {
    const result = matchSmsDeposit(onA, [dep({ collectionAccountId: 'A' })], NOW);
    expect(result).toMatchObject({
      type: 'matched',
      intentId: 'i1',
      confidence: 'amount_and_phone',
    });
  });

  it('never credits a deposit of another account, even for the same amount and phone', () => {
    const result = matchSmsDeposit(onA, [dep({ collectionAccountId: 'B' })], NOW);
    expect(result).toEqual({ type: 'unmatched', reason: 'no_open_deposit' });
  });

  it('keeps the same amount on two accounts apart', () => {
    const open = [
      dep({ intentId: 'a', userId: 'ua', collectionAccountId: 'A', phone: '+251911111111' }),
      dep({ intentId: 'b', userId: 'ub', collectionAccountId: 'B', phone: '+251922222222' }),
    ];
    const onB = { ...credit, collectionAccountId: 'B' };
    expect(matchSmsDeposit(onA, open, NOW)).toMatchObject({ type: 'matched', intentId: 'a' });
    expect(matchSmsDeposit(onB, open, NOW)).toMatchObject({ type: 'matched', intentId: 'b' });
  });

  it('the phone fallback does not look at other accounts either', () => {
    const open = [dep({ collectionAccountId: 'B', amount: 10_999n })];
    expect(matchSmsDeposit({ ...onA, amount: 10_000n }, open, NOW)).toEqual({
      type: 'unmatched',
      reason: 'no_open_deposit',
    });
  });

  it('a deposit without an account (an older row) matches as before, on any account', () => {
    expect(matchSmsDeposit(onA, [dep({})], NOW)).toMatchObject({ type: 'matched' });
    expect(matchSmsDeposit(onA, [dep({ collectionAccountId: null })], NOW)).toMatchObject({
      type: 'matched',
    });
    expect(matchSmsDeposit(credit, [dep({})], NOW)).toMatchObject({ type: 'matched' });
  });

  it('an SMS of unknown account never credits a deposit that names an account', () => {
    expect(matchSmsDeposit(credit, [dep({ collectionAccountId: 'A' })], NOW)).toEqual({
      type: 'unmatched',
      reason: 'no_open_deposit',
    });
  });

  it('takenAmounts: the account own amounts and those without an account, nothing of other accounts', () => {
    const open = [
      { amount: 10_001n, collectionAccountId: 'A' },
      { amount: 10_002n, collectionAccountId: 'B' },
      { amount: 10_003n, collectionAccountId: null },
      { amount: 10_004n },
    ];
    expect([...takenAmounts(open, 'A')].sort()).toEqual([10_001n, 10_003n, 10_004n]);
    expect([...takenAmounts(open, 'B')].sort()).toEqual([10_002n, 10_003n, 10_004n]);
    // With no account every amount is taken, as before accounts existed.
    expect(takenAmounts(open, null).size).toBe(4);
  });

  it('two accounts give twice the open deposits of one for the same base', () => {
    const open: { amount: bigint; collectionAccountId: string }[] = [];
    let full = 0;
    for (const account of ['A', 'B']) {
      for (let i = 0; i < MAX_SANTIM_OFFSET + 5; i++) {
        const amount = allocateSmsAmount(10_000n, takenAmounts(open, account), () => 1 + (i % 99));
        if (amount === null) full++;
        else open.push({ amount, collectionAccountId: account });
      }
    }
    expect(open).toHaveLength(2 * MAX_SANTIM_OFFSET);
    expect(full).toBe(10);
  });

  it('property: no collision within an account, and an SMS only ever pays its own account', () => {
    const accounts = ['A', 'B', 'C'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            account: fc.constantFrom(...accounts),
            base: fc.constantFrom(10_000n, 20_000n),
            offset: fc.integer({ min: 1, max: MAX_SANTIM_OFFSET }),
          }),
          { maxLength: 400 },
        ),
        (requests) => {
          const open: OpenSmsDeposit[] = [];
          for (const [i, r] of requests.entries()) {
            const amount = allocateSmsAmount(r.base, takenAmounts(open, r.account), () => r.offset);
            if (amount === null) continue;
            open.push(
              deposit({
                intentId: `d${i}`,
                userId: `u${i}`,
                amount,
                collectionAccountId: r.account,
                phone: `+2519${String(i).padStart(8, '0')}`,
              }),
            );
          }
          for (const account of accounts) {
            const amounts = open
              .filter((d) => d.collectionAccountId === account)
              .map((d) => d.amount);
            expect(new Set(amounts).size).toBe(amounts.length);
          }
          for (const d of open) {
            const sms = {
              direction: 'credit' as const,
              amount: d.amount,
              counterpartyPhone: null,
              collectionAccountId: d.collectionAccountId,
            };
            const result = matchSmsDeposit(sms, open, NOW);
            expect(result).toMatchObject({ type: 'matched', intentId: d.intentId });
          }
        },
      ),
    );
  });
});

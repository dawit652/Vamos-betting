import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  amlLookbackMs,
  amlWindowKey,
  countBreaches,
  DEFAULT_AML_RULES,
  evaluateAmlActivity,
  evaluateCashOutChurn,
  evaluateDepositsThenWithdraw,
  evaluateDepositThenWithdraw,
  evaluateStructuring,
  evaluateVelocity,
} from './aml';
import { birr } from './money';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-10-18 06:00 in Addis Ababa (03:00 UTC). */
const T0 = Date.parse('2026-10-18T03:00:00Z');
const velocity = DEFAULT_AML_RULES.depositVelocity; // > 5 an hour or > 10 a day

/** Brute force: the count of the window (t - w, t]. */
function countAt(times: readonly number[], t: number, w: number): number {
  return times.filter((x) => x > t - w && x <= t).length;
}

describe('countBreaches', () => {
  it('counts the window (t - w, t] at each distinct event time', () => {
    const times = [0, 10, 10, 20, 30];
    expect(countBreaches(times, 15, 1)).toEqual([
      { atMs: 10, count: 3 },
      { atMs: 20, count: 3 },
      { atMs: 30, count: 2 },
    ]);
    expect(countBreaches([], 10, 0)).toEqual([]);
    expect(() => countBreaches([Number.NaN], 10, 0)).toThrow(RangeError);
    expect(() => countBreaches([1], 0, 0)).toThrow(RangeError);
    expect(() => countBreaches([1], 10, -1)).toThrow(RangeError);
  });

  it('agrees with a brute-force count (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 60 }),
        fc.integer({ min: 1, max: 3_000 }),
        fc.integer({ min: 0, max: 8 }),
        (times, w, max) => {
          const expected = [...new Set(times)]
            .sort((a, b) => a - b)
            .map((t) => ({ atMs: t, count: countAt(times, t, w) }))
            .filter((breach) => breach.count > max);
          expect(countBreaches(times, w, max)).toEqual(expected);
        },
      ),
    );
  });
});

describe('velocity', () => {
  it('fires above the hourly limit, not at it', () => {
    const five = [0, 1, 2, 3, 4].map((i) => T0 + i * 10 * MIN);
    expect(evaluateVelocity('deposit_velocity', velocity, five)).toEqual([]);
    const six = [...five, T0 + 50 * MIN];
    const hits = evaluateVelocity('deposit_velocity', velocity, six);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rule: 'deposit_velocity',
      severity: 'medium',
      windowKey: '2026-10-18',
      atMs: T0 + 50 * MIN,
      details: { window: 'hour', count: 6, max: 5 },
    });
    // Spread over more than an hour, six are fine; eleven in a day are not.
    const spread = Array.from({ length: 10 }, (_, i) => T0 + i * 61 * MIN);
    expect(evaluateVelocity('deposit_velocity', velocity, spread)).toEqual([]);
    const eleven = [...spread, T0 + 11 * HOUR];
    expect(evaluateVelocity('deposit_velocity', velocity, eleven)).toMatchObject([
      { details: { window: 'day', count: 11, max: 10 } },
    ]);
  });

  it('keeps one hit per business day, so a later burst is not hidden by an earlier one', () => {
    const burst = (start: number) => Array.from({ length: 6 }, (_, i) => start + i * MIN);
    const times = [...burst(T0), ...burst(T0 + 5 * MIN), ...burst(T0 + 26 * HOUR)];
    const hits = evaluateVelocity('deposit_velocity', velocity, times);
    expect(hits.map((hit) => hit.windowKey)).toEqual(['2026-10-18', '2026-10-19']);
    // Re-evaluating with more events of the same day keeps the same first hit.
    const again = evaluateVelocity('deposit_velocity', velocity, [...times, T0 + 2 * HOUR]);
    expect(again[0]).toEqual(hits[0]);
    expect(evaluateVelocity('deposit_velocity', { ...velocity, enabled: false }, times)).toEqual(
      [],
    );
  });

  it('dates the hit in Addis Ababa time', () => {
    // 22:30 UTC is already the next day in Addis Ababa.
    expect(amlWindowKey(Date.parse('2026-10-18T22:30:00Z'))).toBe('2026-10-19');
  });
});

describe('structuring', () => {
  const rule = DEFAULT_AML_RULES.structuring; // threshold 100,000 ETB, near from 90%

  it('fires on two deposits just below the threshold within 24 hours', () => {
    const near = [
      { atMs: T0, amount: birr(95_000) },
      { atMs: T0 + 20 * HOUR, amount: birr(99_999) },
    ];
    expect(evaluateStructuring(rule, near)).toMatchObject([
      { rule: 'structuring', severity: 'high', details: { reason: 'near_threshold' } },
    ]);
    // More than 24 hours apart: no window holds both.
    expect(
      evaluateStructuring(rule, [near[0]!, { atMs: T0 + 24 * HOUR, amount: birr(99_999) }]),
    ).toEqual([]);
  });

  it('fires when deposits below the threshold sum to it', () => {
    const parts = [40_000, 35_000, 25_000].map((value, i) => ({
      atMs: T0 + i * HOUR,
      amount: birr(value),
    }));
    expect(evaluateStructuring(rule, parts)).toMatchObject([
      { details: { reason: 'sum_above_threshold', total: String(birr(100_000)), count: 3 } },
    ]);
    expect(evaluateStructuring(rule, parts.slice(0, 2))).toEqual([]);
  });

  it('ignores deposits at or above the threshold and single deposits', () => {
    expect(
      evaluateStructuring(rule, [
        { atMs: T0, amount: birr(100_000) },
        { atMs: T0 + HOUR, amount: birr(100_000) },
      ]),
    ).toEqual([]);
    expect(evaluateStructuring(rule, [{ atMs: T0, amount: birr(99_999) }])).toEqual([]);
  });

  it('never fires on windows that stay clear of both conditions (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            atMs: fc.integer({ min: T0, max: T0 + 72 * HOUR }),
            amount: fc.bigInt({ min: 1n, max: birr(150_000) }),
          }),
          { maxLength: 30 },
        ),
        (deposits) => {
          const hits = evaluateStructuring(rule, deposits);
          const threshold = rule.reportingThreshold;
          const nearFloor = (threshold * BigInt(rule.nearThresholdBps)) / 10_000n;
          const below = deposits.filter((deposit) => deposit.amount < threshold);
          for (const hit of hits) {
            const inWindow = below.filter(
              (deposit) => deposit.atMs > hit.atMs - 24 * HOUR && deposit.atMs <= hit.atMs,
            );
            const sum = inWindow.reduce((total, deposit) => total + deposit.amount, 0n);
            const near = inWindow.filter((deposit) => deposit.amount >= nearFloor).length;
            expect(near >= rule.minNearCount || (inWindow.length >= 2 && sum >= threshold)).toBe(
              true,
            );
          }
          // And every window that matches is covered by a hit on its day or earlier that day.
          for (const deposit of below) {
            const inWindow = below.filter(
              (other) => other.atMs > deposit.atMs - 24 * HOUR && other.atMs <= deposit.atMs,
            );
            const sum = inWindow.reduce((total, other) => total + other.amount, 0n);
            const near = inWindow.filter((other) => other.amount >= nearFloor).length;
            if (near >= rule.minNearCount || (inWindow.length >= 2 && sum >= threshold)) {
              const key = amlWindowKey(deposit.atMs);
              const hit = hits.find((candidate) => candidate.windowKey === key);
              expect(hit !== undefined && hit.atMs <= deposit.atMs).toBe(true);
            }
          }
        },
      ),
    );
  });
});

describe('deposit then withdraw', () => {
  const rule = DEFAULT_AML_RULES.depositThenWithdraw; // stakes < 50% of a deposit >= 1,000 ETB

  it('fires when less than the share of the last deposit was staked', () => {
    const input = { deposit: birr(10_000), depositRef: 'i1', atMs: T0 };
    expect(evaluateDepositThenWithdraw(rule, { ...input, stakesSince: birr(4_999) })).toMatchObject(
      { rule: 'deposit_then_withdraw', severity: 'high', windowKey: 'deposit:i1' },
    );
    expect(evaluateDepositThenWithdraw(rule, { ...input, stakesSince: birr(5_000) })).toBeNull();
    // Small deposits are not looked at.
    expect(
      evaluateDepositThenWithdraw(rule, { ...input, deposit: birr(999), stakesSince: 0n }),
    ).toBeNull();
    expect(() => evaluateDepositThenWithdraw(rule, { ...input, stakesSince: -1n })).toThrow(
      RangeError,
    );
  });

  it('fires exactly when stakes x 10000 < deposit x share (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: birr(1_000), max: birr(1_000_000) }),
        fc.bigInt({ min: 0n, max: birr(2_000_000) }),
        fc.integer({ min: 0, max: 10_000 }),
        (deposit, stakesSince, share) => {
          const hit = evaluateDepositThenWithdraw(
            { ...rule, minStakeShareBps: share },
            { deposit, stakesSince, depositRef: 'x', atMs: T0 },
          );
          expect(hit !== null).toBe(stakesSince * 10_000n < deposit * BigInt(share));
        },
      ),
    );
  });
});

describe('deposits then withdraw (every deposit since the last withdrawal)', () => {
  const rule = DEFAULT_AML_RULES.depositThenWithdraw;
  const dep = (ref: string, atMs: number, amount: bigint, stakesSince = 0n) => ({
    ref,
    atMs,
    amount,
    stakesSince,
  });

  it('a small top-up after an unplayed deposit does not hide it', () => {
    const big = dep('d1', T0, birr(2_000));
    const topUp = dep('d2', T0 + MIN, birr(10));
    expect(evaluateDepositsThenWithdraw(rule, { deposits: [big], atMs: T0 + HOUR })).toMatchObject({
      windowKey: 'deposit:d1',
    });
    expect(
      evaluateDepositsThenWithdraw(rule, { deposits: [topUp, big], atMs: T0 + HOUR }),
    ).toMatchObject({
      rule: 'deposit_then_withdraw',
      windowKey: 'deposit:d1',
      details: { deposit: birr(2_010).toString(), stakesSince: '0', deposits: 2 },
    });
    // 2,000 then 1,000 with 500 staked after the second: 500 of 3,000 is under half.
    expect(
      evaluateDepositsThenWithdraw(rule, {
        deposits: [
          dep('a', T0, birr(2_000), birr(500)),
          dep('b', T0 + MIN, birr(1_000), birr(500)),
        ],
        atMs: T0 + HOUR,
      }),
    ).toMatchObject({ windowKey: 'deposit:a' });
    // Played through: 1,200 of 2,010 staked.
    expect(
      evaluateDepositsThenWithdraw(rule, {
        deposits: [dep('a', T0, birr(2_000), birr(1_200)), dep('b', T0 + MIN, birr(10))],
        atMs: T0 + HOUR,
      }),
    ).toBeNull();
    expect(evaluateDepositsThenWithdraw(rule, { deposits: [], atMs: T0 })).toBeNull();
  });

  const depositsArb = fc
    .array(
      fc.record({
        amount: fc.bigInt({ min: 0n, max: birr(5_000) }),
        stake: fc.bigInt({ min: 0n, max: birr(5_000) }),
      }),
      { maxLength: 6 },
    )
    .map((rows) => {
      // Stakes since a deposit include the stakes since every later one.
      let stakes = 0n;
      const out = rows.map((row, i) => ({ ref: `d${i}`, atMs: T0 + i * MIN, amount: row.amount }));
      const since = new Array<bigint>(rows.length);
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        stakes += rows[i]!.stake;
        since[i] = stakes;
      }
      return out.map((row, i) => ({ ...row, stakesSince: since[i]! }));
    });

  it('fires exactly when some deposit and those after it are under-played (property)', () => {
    fc.assert(
      fc.property(depositsArb, (deposits) => {
        const hit = evaluateDepositsThenWithdraw(rule, { deposits, atMs: T0 + HOUR });
        const expected = deposits.findIndex((d, i) => {
          const sum = deposits.slice(i).reduce((acc, x) => acc + x.amount, 0n);
          return sum >= rule.minDeposit && d.stakesSince * 10_000n < sum * 5_000n;
        });
        expect(hit?.windowKey ?? null).toBe(
          expected < 0 ? null : `deposit:${deposits[expected]!.ref}`,
        );
      }),
    );
  });

  it('a later deposit never clears a hit (property)', () => {
    fc.assert(
      fc.property(depositsArb, fc.bigInt({ min: 0n, max: birr(5_000) }), (deposits, topUp) => {
        const before = evaluateDepositsThenWithdraw(rule, { deposits, atMs: T0 + HOUR });
        fc.pre(before !== null);
        const after = evaluateDepositsThenWithdraw(rule, {
          deposits: [
            ...deposits,
            { ref: 'zz', atMs: T0 + 30 * MIN, amount: topUp, stakesSince: 0n },
          ],
          atMs: T0 + HOUR,
        });
        expect(after).not.toBeNull();
      }),
    );
  });
});

describe('cash-out churn', () => {
  const rule = DEFAULT_AML_RULES.cashOutChurn; // 5 quick cash-outs (<= 10 min) in 24 h

  it('counts only quick cash-outs', () => {
    const quick = Array.from({ length: 5 }, (_, i) => ({
      atMs: T0 + i * HOUR,
      placedAtMs: T0 + i * HOUR - 5 * MIN,
    }));
    expect(evaluateCashOutChurn(rule, quick)).toMatchObject([
      { rule: 'cashout_churn', details: { count: 5 } },
    ]);
    expect(evaluateCashOutChurn(rule, quick.slice(0, 4))).toEqual([]);
    const slow = quick.map((cashOut) => ({ ...cashOut, placedAtMs: cashOut.atMs - 11 * MIN }));
    expect(evaluateCashOutChurn(rule, slow)).toEqual([]);
  });
});

describe('evaluateAmlActivity', () => {
  it('finds nothing in ordinary play and nothing when switched off', () => {
    const activity = {
      deposits: [
        { atMs: T0, amount: birr(500) },
        { atMs: T0 + 3 * HOUR, amount: birr(1_000) },
      ],
      withdrawals: [{ atMs: T0 + 10 * HOUR }],
      cashOuts: [{ atMs: T0 + 2 * HOUR, placedAtMs: T0 + HOUR }],
    };
    expect(evaluateAmlActivity(DEFAULT_AML_RULES, activity)).toEqual([]);
    const busy = {
      ...activity,
      withdrawals: Array.from({ length: 4 }, (_, i) => ({ atMs: T0 + i * MIN })),
    };
    expect(evaluateAmlActivity(DEFAULT_AML_RULES, busy).map((hit) => hit.rule)).toEqual([
      'withdrawal_velocity',
    ]);
    expect(evaluateAmlActivity({ ...DEFAULT_AML_RULES, enabled: false }, busy)).toEqual([]);
  });

  it('looks back twice the longest window', () => {
    expect(amlLookbackMs(DEFAULT_AML_RULES)).toBe(48 * HOUR);
    expect(
      amlLookbackMs({
        ...DEFAULT_AML_RULES,
        structuring: { ...DEFAULT_AML_RULES.structuring, windowHours: 72 },
      }),
    ).toBe(144 * HOUR);
  });
});

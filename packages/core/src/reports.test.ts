import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addBusinessDays, businessDayWindow } from './businessday';
import {
  addReportTotals,
  classifyReportPosting,
  REPORT_PERIODS,
  reportImbalance,
  reportTotalsOfPostings,
  reportWindow,
  summarizeReport,
  type ReportFigures,
  type ReportPosting,
} from './reports';

const posting = (
  type: string,
  key: string,
  channel: 'online' | 'shop',
  entries: Array<[kind: string, amount: bigint, provider?: string]>,
  reversedType?: string,
): ReportPosting => ({
  type,
  idempotencyKey: key,
  channel,
  ...(reversedType === undefined ? {} : { reversedType }),
  entries: entries.map(([kind, amount, provider]) => ({
    kind,
    amount,
    provider: provider ?? null,
  })),
});

describe('reportWindow (Ethiopian time, UTC+3)', () => {
  it('a day starts at 00:00 in Addis Ababa (21:00 UTC the day before)', () => {
    const w = reportWindow('day', '2026-11-22');
    expect(w).toMatchObject({
      firstDay: '2026-11-22',
      lastDay: '2026-11-22',
      days: ['2026-11-22'],
    });
    expect(w.start.toISOString()).toBe('2026-11-21T21:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-11-22T21:00:00.000Z');
  });

  it('a week runs Monday to Sunday', () => {
    // 22 Nov 2026 is a Sunday.
    expect(reportWindow('week', '2026-11-22')).toMatchObject({
      firstDay: '2026-11-16',
      lastDay: '2026-11-22',
    });
    expect(reportWindow('week', '2026-11-23').firstDay).toBe('2026-11-23');
    expect(reportWindow('week', '2026-11-25').days).toHaveLength(7);
  });

  it('a month and a year have all their days, leap years included', () => {
    expect(reportWindow('month', '2028-02-10')).toMatchObject({
      firstDay: '2028-02-01',
      lastDay: '2028-02-29',
    });
    expect(reportWindow('month', '2026-02-10').lastDay).toBe('2026-02-28');
    expect(reportWindow('month', '2026-12-31')).toMatchObject({
      firstDay: '2026-12-01',
      lastDay: '2026-12-31',
    });
    expect(reportWindow('year', '2026-07-01').days).toHaveLength(365);
    expect(reportWindow('year', '2028-07-01').days).toHaveLength(366);
    expect(reportWindow('year', '2026-07-01').end.toISOString()).toBe('2026-12-31T21:00:00.000Z');
  });

  it('refuses a date that is not YYYY-MM-DD', () => {
    expect(() => reportWindow('day', '2026-13-01')).toThrow(RangeError);
    expect(() => reportWindow('month', '22/11/2026')).toThrow(RangeError);
  });

  it('every period holds its date, is exactly the union of its days, and the next period starts at its end', () => {
    const dateArb = fc
      .integer({ min: 0, max: 365 * 40 })
      .map((n) => addBusinessDays('2000-01-01', n));
    fc.assert(
      fc.property(dateArb, fc.constantFrom(...REPORT_PERIODS), (date, period) => {
        const w = reportWindow(period, date);
        expect(w.days).toContain(date);
        expect(w.days[0]).toBe(w.firstDay);
        expect(w.days.at(-1)).toBe(w.lastDay);
        for (let i = 1; i < w.days.length; i += 1) {
          expect(businessDayWindow(w.days[i]!).start.getTime()).toBe(
            businessDayWindow(w.days[i - 1]!).end.getTime(),
          );
        }
        expect(businessDayWindow(w.firstDay).start).toEqual(w.start);
        expect(businessDayWindow(w.lastDay).end).toEqual(w.end);
        const next = reportWindow(period, addBusinessDays(w.lastDay, 1));
        expect(next.start).toEqual(w.end);
        // Every day of the period maps back to this same period.
        expect(reportWindow(period, w.days[Math.floor(w.days.length / 2)]!).firstDay).toBe(
          w.firstDay,
        );
      }),
    );
  });
});

describe('classifyReportPosting', () => {
  it('sorts each ledger type into its category', () => {
    const c = (type: string, key = 'k', reversedType?: string) =>
      classifyReportPosting({ type, idempotencyKey: key, reversedType: reversedType ?? null });
    expect(c('bet_stake')).toBe('bet_stake');
    expect(c('bet_refund', 'reject:b1')).toBe('bet_rejection');
    expect(c('bet_refund', 'settle:b1:1')).toBe('bet_void');
    expect(c('bet_payout')).toBe('bet_settlement');
    expect(c('settlement_reversal', 'reverse:b1:1', 'bet_payout')).toBe('bet_settlement');
    expect(c('settlement_reversal', 'reverse:b1:1', 'bet_refund')).toBe('bet_void');
    expect(c('settlement_reversal', 'reverse:b1:1', 'bet_cashout')).toBe('bet_cashout');
    expect(c('retail_ticket_cancel')).toBe('shop_ticket_cancelled');
    expect(c('retail_ticket_payout')).toBe('shop_ticket_paid');
    expect(c('retail_ticket_expiry')).toBe('shop_ticket_expired');
    expect(c('jackpot_entry', 'jackpot:e1')).toBe('jackpot_entry');
    expect(c('jackpot_entry', 'jackpot_refund:e1')).toBe('jackpot_refund');
    expect(c('withdrawal', 'withdrawal:p1:hold')).toBe('withdrawal_hold');
    expect(c('withdrawal', 'withdrawal:p1:paid')).toBe('withdrawal_paid');
    expect(c('withdrawal_reversal')).toBe('withdrawal_returned');
    expect(c('demo_topup')).toBe('other');
  });
});

/** A day with every kind of posting; the expected figures are worked out by hand. */
const SAMPLE: ReportPosting[] = [
  // Online: five stakes (100, 50, 30, 40, 20).
  posting('bet_stake', 'bet:1', 'online', [
    ['player_cash', -100n],
    ['house_stakes', 100n],
  ]),
  posting('bet_stake', 'bet:2', 'online', [
    ['player_cash', -50n],
    ['house_stakes', 50n],
  ]),
  posting('bet_stake', 'bet:3', 'online', [
    ['player_cash', -30n],
    ['house_stakes', 30n],
  ]),
  posting('bet_stake', 'bet:4', 'online', [
    ['player_cash', -40n],
    ['house_stakes', 40n],
  ]),
  posting('bet_stake', 'bet:5', 'online', [
    ['player_cash', -20n],
    ['house_stakes', 20n],
  ]),
  // Won at 2.50: 250 gross, 20 tax, 230 to the player.
  posting('bet_payout', 'settle:1:1', 'online', [
    ['player_cash', 230n],
    ['house_tax_payable', 20n],
    ['house_stakes', -100n],
    ['house_revenue', -150n],
  ]),
  // Lost.
  posting('bet_payout', 'settle:2:1', 'online', [
    ['house_stakes', -50n],
    ['house_revenue', 50n],
  ]),
  // Void.
  posting('bet_refund', 'settle:3:1', 'online', [
    ['house_stakes', -30n],
    ['player_cash', 30n],
  ]),
  // Cashed out for 35.
  posting('bet_cashout', 'cashout:4', 'online', [
    ['house_stakes', -40n],
    ['player_cash', 35n],
    ['house_revenue', 5n],
  ]),
  // Live bet refused after its delay.
  posting('bet_refund', 'reject:5', 'online', [
    ['house_stakes', -20n],
    ['player_cash', 20n],
  ]),
  // Shop: two tickets (60 and 10), the second cancelled; the first wins 100.
  posting('bet_stake', 'bet:6', 'shop', [
    ['agent_balance', -60n],
    ['house_stakes', 60n],
  ]),
  posting('bet_stake', 'bet:7', 'shop', [
    ['agent_balance', -10n],
    ['house_stakes', 10n],
  ]),
  posting('retail_ticket_cancel', 'cancel:7', 'shop', [
    ['house_stakes', -10n],
    ['agent_balance', 10n],
  ]),
  posting('bet_payout', 'settle:6:1', 'shop', [
    ['house_retail_payable', 100n],
    ['house_stakes', -60n],
    ['house_revenue', -40n],
  ]),
  posting('retail_ticket_payout', 'retail-payout:6', 'shop', [
    ['house_retail_payable', -100n],
    ['agent_balance', 100n],
  ]),
  posting('agent_topup', 'topup:1', 'shop', [
    ['house_agent_funding', -1000n],
    ['agent_balance', 1000n],
  ]),
  // Payments.
  posting('deposit', 'deposit:1', 'online', [
    ['house_psp_clearing', -500n, 'chapa'],
    ['player_cash', 500n],
  ]),
  posting('deposit', 'deposit:2', 'online', [
    ['house_psp_clearing', -300n, 'sms'],
    ['player_cash', 300n],
  ]),
  posting('withdrawal', 'withdrawal:p1:hold', 'online', [
    ['player_cash', -200n],
    ['house_withdrawals_pending', 200n],
  ]),
  posting('withdrawal', 'withdrawal:p1:paid', 'online', [
    ['house_withdrawals_pending', -150n],
    ['house_psp_clearing', 150n, 'telebirr'],
  ]),
  posting('withdrawal_reversal', 'withdrawal:p1:reversal', 'online', [
    ['house_withdrawals_pending', -50n],
    ['player_cash', 50n],
  ]),
  // Jackpot: one entry of 10, a prize of 100 with 15 tax.
  posting('jackpot_entry', 'jackpot:e1', 'online', [
    ['player_cash', -10n],
    ['house_jackpot', 10n],
  ]),
  posting('jackpot_prize', 'jackpot_prize:e1', 'online', [
    ['house_jackpot', -100n],
    ['player_cash', 85n],
    ['house_tax_payable', 15n],
  ]),
  posting('bonus', 'bonus:1', 'online', [
    ['house_promotions', -25n],
    ['player_bonus', 25n],
  ]),
];

describe('summarizeReport', () => {
  it('works out every figure of a day with every kind of posting', () => {
    const totals = reportTotalsOfPostings(SAMPLE);
    expect(reportImbalance(totals)).toBe(0n);
    const f = summarizeReport(totals);
    expect(f.online).toEqual({
      bets: 4,
      stakes: 220n,
      wonPayouts: 250n,
      cashOuts: 35n,
      refunds: 30n,
      payouts: 315n,
      ggr: -95n,
      taxWithheld: 20n,
    });
    expect(f.shop).toMatchObject({
      bets: 1,
      stakes: 60n,
      wonPayouts: 100n,
      payouts: 100n,
      ggr: -40n,
      taxWithheld: 0n,
      ticketsPaid: 100n,
      ticketsPaidCount: 1,
      unclaimed: 0n,
      agentTopups: 1000n,
      agentTopupCount: 1,
    });
    expect(f.jackpot).toEqual({
      entries: 1,
      stakes: 10n,
      refunds: 0n,
      prizes: 100n,
      result: -90n,
      taxWithheld: 15n,
    });
    expect(f.totalGgr).toBe(-95n - 40n - 90n);
    expect(f.taxWithheld).toBe(35n);
    expect(f.deposits).toEqual({
      total: 800n,
      count: 2,
      byProvider: [
        { provider: 'chapa', amount: 500n, count: 1 },
        { provider: 'sms', amount: 300n, count: 1 },
      ],
    });
    expect(f.withdrawals).toEqual({
      requested: 200n,
      requestedCount: 1,
      paid: 150n,
      paidCount: 1,
      returned: 50n,
      returnedCount: 1,
      paidByProvider: [{ provider: 'telebirr', amount: 150n, count: 1 }],
    });
    expect(f.bonuses).toBe(25n);
  });

  it('an unbalanced posting shows as an imbalance', () => {
    const bad = posting('deposit', 'deposit:x', 'online', [
      ['house_psp_clearing', -100n, 'chapa'],
      ['player_cash', 99n],
    ]);
    expect(reportImbalance(reportTotalsOfPostings([...SAMPLE, bad]))).toBe(-1n);
  });
});

/** Every number in the figures, by path (providers by name), to compare sums. */
function flatten(figures: ReportFigures): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'bigint') out.set(path, value);
    else if (typeof value === 'number') out.set(path, BigInt(value));
    else if (Array.isArray(value)) {
      for (const item of value as Array<{ provider: string }>)
        walk(item, `${path}[${item.provider}]`);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key !== 'provider') walk(inner, `${path}.${key}`);
      }
    }
  };
  walk(figures, '');
  return out;
}

const postingArb: fc.Arbitrary<ReportPosting> = fc
  .record({
    index: fc.integer({ min: 0, max: SAMPLE.length - 1 }),
    scale: fc.bigInt({ min: 1n, max: 1_000_000n }),
  })
  .map(({ index, scale }) => {
    const base = SAMPLE[index]!;
    return { ...base, entries: base.entries.map((e) => ({ ...e, amount: e.amount * scale })) };
  });

describe('a period is exactly the sum of its days', () => {
  it('the figures of two days together equal the sum of each day’s figures, for every figure', () => {
    fc.assert(
      fc.property(
        fc.array(postingArb, { maxLength: 30 }),
        fc.array(postingArb, { maxLength: 30 }),
        (a, b) => {
          const dayA = reportTotalsOfPostings(a);
          const dayB = reportTotalsOfPostings(b);
          const both = flatten(summarizeReport(addReportTotals(dayA, dayB)));
          const one = flatten(summarizeReport(dayA));
          const two = flatten(summarizeReport(dayB));
          for (const [path, value] of both) {
            expect(value, path).toBe((one.get(path) ?? 0n) + (two.get(path) ?? 0n));
          }
          for (const path of [...one.keys(), ...two.keys()])
            expect(both.has(path), path).toBe(true);
          // Grouping all postings at once gives the same rows as adding the days' rows.
          expect(reportTotalsOfPostings([...a, ...b])).toEqual(addReportTotals(dayA, dayB));
          expect(reportImbalance(addReportTotals(dayA, dayB))).toBe(0n);
        },
      ),
    );
  });

  it('adding days is order-independent', () => {
    fc.assert(
      fc.property(fc.array(fc.array(postingArb, { maxLength: 8 }), { maxLength: 6 }), (days) => {
        const totals = days.map((d) => reportTotalsOfPostings(d));
        expect(addReportTotals(...totals)).toEqual(addReportTotals(...[...totals].reverse()));
      }),
    );
  });
});

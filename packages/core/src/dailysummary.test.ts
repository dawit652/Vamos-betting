import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyPosting,
  csvField,
  dailySummaryCsv,
  diffDailyFigures,
  elsCommissionDue,
  summarizeDailyTotals,
  totalsOfPostings,
  type DailySummaryRow,
  type SummaryPosting,
} from './dailysummary';

/**
 * Postings shaped exactly like the database's posting helpers
 * (packages/db betting/postings.ts, jackpots/entries.ts, payments/postings.ts):
 * the spec the summary is checked against.
 */
type Entry = { kind: string; amount: bigint };
const entries = (...list: Entry[]): Entry[] => list.filter((entry) => entry.amount !== 0n);
const negate = (list: readonly Entry[]): Entry[] =>
  list.map((entry) => ({ kind: entry.kind, amount: -entry.amount }));

const stakePosting = (stake: bigint): SummaryPosting => ({
  type: 'bet_stake',
  idempotencyKey: 'bet:u:k',
  entries: entries(
    { kind: 'player_cash', amount: -stake },
    { kind: 'house_stakes', amount: stake },
  ),
});
const rejectionPosting = (stake: bigint): SummaryPosting => ({
  type: 'bet_refund',
  idempotencyKey: 'reject:b',
  entries: entries(
    { kind: 'house_stakes', amount: -stake },
    { kind: 'player_cash', amount: stake },
  ),
});
const wonEntries = (stake: bigint, gross: bigint, tax: bigint): Entry[] =>
  entries(
    { kind: 'player_cash', amount: gross - tax },
    { kind: 'house_tax_payable', amount: tax },
    { kind: 'house_stakes', amount: -stake },
    { kind: 'house_revenue', amount: -(gross - stake) },
  );
const lostEntries = (stake: bigint): Entry[] =>
  entries({ kind: 'house_stakes', amount: -stake }, { kind: 'house_revenue', amount: stake });
const voidEntries = (stake: bigint): Entry[] =>
  entries({ kind: 'house_stakes', amount: -stake }, { kind: 'player_cash', amount: stake });
const cashOutEntries = (stake: bigint, gross: bigint, tax: bigint): Entry[] =>
  entries(
    { kind: 'house_stakes', amount: -stake },
    { kind: 'player_cash', amount: gross - tax },
    { kind: 'house_tax_payable', amount: tax },
    { kind: 'house_revenue', amount: stake - gross },
  );

/** A day's business, as the generator draws it. */
type Op =
  | {
      op: 'bet';
      stake: bigint;
      outcome: 'won' | 'lost' | 'void' | 'open' | 'rejected' | 'cashout';
      gross: bigint;
      tax: bigint;
      reversed: boolean;
    }
  | {
      op: 'jackpot';
      cost: bigint;
      outcome: 'won' | 'lost' | 'void' | 'open';
      gross: bigint;
      tax: bigint;
    }
  | { op: 'bonus'; amount: bigint }
  | { op: 'deposit'; amount: bigint }
  | { op: 'withdrawal'; amount: bigint; paid: boolean }
  | { op: 'topup'; amount: bigint };

const amount = fc.bigInt({ min: 1n, max: 50_000_000n });

const betOp: fc.Arbitrary<Op> = fc
  .record({
    stake: amount,
    outcome: fc.constantFrom<'won' | 'lost' | 'void' | 'open' | 'rejected' | 'cashout'>(
      'won',
      'lost',
      'void',
      'open',
      'rejected',
      'cashout',
    ),
    extra: fc.bigInt({ min: 0n, max: 100_000_000n }),
    taxShare: fc.integer({ min: 0, max: 100 }),
    reversed: fc.boolean(),
  })
  .map(({ stake, outcome, extra, taxShare, reversed }) => {
    // won: gross >= stake; cash-out: any positive gross (tax only on what exceeds the stake).
    const gross = outcome === 'cashout' ? (extra % (2n * stake)) + 1n : stake + extra;
    const winnings = gross > stake ? gross - stake : 0n;
    const tax = (winnings * BigInt(taxShare)) / 100n;
    return { op: 'bet', stake, outcome, gross, tax, reversed } as const;
  });

const jackpotOp: fc.Arbitrary<Op> = fc
  .record({
    cost: amount,
    outcome: fc.constantFrom<'won' | 'lost' | 'void' | 'open'>('won', 'lost', 'void', 'open'),
    gross: amount,
    taxShare: fc.integer({ min: 0, max: 100 }),
  })
  .map(({ cost, outcome, gross, taxShare }): Op => ({
    op: 'jackpot',
    cost,
    outcome,
    gross,
    tax: (gross * BigInt(taxShare)) / 100n,
  }));

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: betOp },
  { weight: 2, arbitrary: jackpotOp },
  { weight: 1, arbitrary: amount.map((value): Op => ({ op: 'bonus', amount: value })) },
  { weight: 1, arbitrary: amount.map((value): Op => ({ op: 'deposit', amount: value })) },
  {
    weight: 1,
    arbitrary: fc
      .record({ value: amount, paid: fc.boolean() })
      .map(({ value, paid }): Op => ({ op: 'withdrawal', amount: value, paid })),
  },
  { weight: 1, arbitrary: amount.map((value): Op => ({ op: 'topup', amount: value })) },
);

interface Expected {
  betStakes: bigint;
  betCount: number;
  jackpotStakes: bigint;
  jackpotEntryCount: number;
  wonPayouts: bigint;
  cashOuts: bigint;
  refunds: bigint;
  jackpotPrizes: bigint;
  taxWithheld: bigint;
  bonuses: bigint;
  deposits: bigint;
  depositCount: number;
  withdrawals: bigint;
  withdrawalCount: number;
}

/** The postings of the ops and the figures expected from the ops themselves (not from the postings). */
function build(ops: readonly Op[]): { postings: SummaryPosting[]; expected: Expected } {
  const postings: SummaryPosting[] = [];
  const e: Expected = {
    betStakes: 0n,
    betCount: 0,
    jackpotStakes: 0n,
    jackpotEntryCount: 0,
    wonPayouts: 0n,
    cashOuts: 0n,
    refunds: 0n,
    jackpotPrizes: 0n,
    taxWithheld: 0n,
    bonuses: 0n,
    deposits: 0n,
    depositCount: 0,
    withdrawals: 0n,
    withdrawalCount: 0,
  };
  for (const op of ops) {
    switch (op.op) {
      case 'bet': {
        postings.push(stakePosting(op.stake));
        e.betStakes += op.stake;
        e.betCount += 1;
        if (op.outcome === 'open') break;
        if (op.outcome === 'rejected') {
          postings.push(rejectionPosting(op.stake));
          e.betStakes -= op.stake;
          e.betCount -= 1;
          break;
        }
        if (op.outcome === 'cashout') {
          postings.push({
            type: 'bet_cashout',
            idempotencyKey: 'cashout:b',
            entries: cashOutEntries(op.stake, op.gross, op.tax),
          });
          e.cashOuts += op.gross;
          e.taxWithheld += op.tax;
          break;
        }
        const type = op.outcome === 'void' ? 'bet_refund' : 'bet_payout';
        const settled =
          op.outcome === 'won'
            ? wonEntries(op.stake, op.gross, op.tax)
            : op.outcome === 'lost'
              ? lostEntries(op.stake)
              : voidEntries(op.stake);
        postings.push({ type, idempotencyKey: 'settle:b:0', entries: settled });
        const paid = op.outcome === 'won' ? op.gross : op.outcome === 'void' ? op.stake : 0n;
        const tax = op.outcome === 'won' ? op.tax : 0n;
        if (op.outcome === 'void') e.refunds += paid;
        else e.wonPayouts += paid;
        e.taxWithheld += tax;
        if (op.reversed) {
          // A correction reverses the settlement (the bet is open again).
          postings.push({
            type: 'settlement_reversal',
            idempotencyKey: 'reverse:b:0',
            reversedType: type,
            entries: negate(settled),
          });
          if (op.outcome === 'void') e.refunds -= paid;
          else e.wonPayouts -= paid;
          e.taxWithheld -= tax;
        }
        break;
      }
      case 'jackpot': {
        postings.push({
          type: 'jackpot_entry',
          idempotencyKey: 'jackpot_entry:u:k',
          entries: entries(
            { kind: 'player_cash', amount: -op.cost },
            { kind: 'house_jackpot', amount: op.cost },
          ),
        });
        e.jackpotStakes += op.cost;
        e.jackpotEntryCount += 1;
        if (op.outcome === 'won') {
          postings.push({
            type: 'jackpot_prize',
            idempotencyKey: 'jackpot_prize:e',
            entries: entries(
              { kind: 'house_jackpot', amount: -op.gross },
              { kind: 'player_cash', amount: op.gross - op.tax },
              { kind: 'house_tax_payable', amount: op.tax },
            ),
          });
          e.jackpotPrizes += op.gross;
          e.taxWithheld += op.tax;
        } else if (op.outcome === 'void') {
          postings.push({
            type: 'jackpot_entry',
            idempotencyKey: 'jackpot_refund:e',
            entries: entries(
              { kind: 'house_jackpot', amount: -op.cost },
              { kind: 'player_cash', amount: op.cost },
            ),
          });
          e.refunds += op.cost;
        }
        break;
      }
      case 'bonus':
        postings.push({
          type: 'bonus',
          idempotencyKey: 'bonus:x',
          entries: entries(
            { kind: 'house_promotions', amount: -op.amount },
            { kind: 'player_bonus', amount: op.amount },
          ),
        });
        e.bonuses += op.amount;
        break;
      case 'deposit':
        postings.push({
          type: 'deposit',
          idempotencyKey: 'deposit:i',
          entries: entries(
            { kind: 'house_psp_clearing', amount: -op.amount },
            { kind: 'player_cash', amount: op.amount },
          ),
        });
        e.deposits += op.amount;
        e.depositCount += 1;
        break;
      case 'withdrawal':
        postings.push({
          type: 'withdrawal',
          idempotencyKey: 'withdrawal:p:hold',
          entries: entries(
            { kind: 'player_cash', amount: -op.amount },
            { kind: 'house_withdrawals_pending', amount: op.amount },
          ),
        });
        if (op.paid) {
          postings.push({
            type: 'withdrawal',
            idempotencyKey: 'withdrawal:p:paid',
            entries: entries(
              { kind: 'house_withdrawals_pending', amount: -op.amount },
              { kind: 'house_psp_clearing', amount: op.amount },
            ),
          });
          e.withdrawals += op.amount;
          e.withdrawalCount += 1;
        } else {
          postings.push({
            type: 'withdrawal_reversal',
            idempotencyKey: 'withdrawal:p:reversal',
            entries: entries(
              { kind: 'house_withdrawals_pending', amount: -op.amount },
              { kind: 'player_cash', amount: op.amount },
            ),
          });
        }
        break;
      case 'topup':
        postings.push({
          type: 'demo_topup',
          idempotencyKey: 'topup:x',
          entries: entries(
            { kind: 'house_demo_funding', amount: -op.amount },
            { kind: 'player_cash', amount: op.amount },
          ),
        });
        break;
    }
  }
  return { postings, expected: e };
}

const BETTING_TYPES = new Set([
  'bet_stake',
  'bet_payout',
  'bet_refund',
  'bet_cashout',
  'settlement_reversal',
  'jackpot_entry',
  'jackpot_prize',
]);

describe('classifyPosting', () => {
  it('tells rejections, void settlements and jackpot refunds apart by their keys', () => {
    expect(classifyPosting({ type: 'bet_refund', idempotencyKey: 'reject:b1' })).toBe(
      'bet_rejection',
    );
    expect(classifyPosting({ type: 'bet_refund', idempotencyKey: 'settle:b1:0' })).toBe('bet_void');
    expect(classifyPosting({ type: 'jackpot_entry', idempotencyKey: 'jackpot_refund:e' })).toBe(
      'jackpot_refund',
    );
    expect(classifyPosting({ type: 'jackpot_entry', idempotencyKey: 'jackpot_entry:u:k' })).toBe(
      'jackpot_entry',
    );
    expect(
      classifyPosting({
        type: 'settlement_reversal',
        idempotencyKey: 'reverse:b:0',
        reversedType: 'bet_refund',
      }),
    ).toBe('bet_void');
    expect(
      classifyPosting({
        type: 'settlement_reversal',
        idempotencyKey: 'reverse:b:0',
        reversedType: 'bet_payout',
      }),
    ).toBe('bet_settlement');
    expect(classifyPosting({ type: 'demo_topup', idempotencyKey: 'x' })).toBe('other');
    expect(classifyPosting({ type: 'withdrawal_reversal', idempotencyKey: 'x' })).toBe('other');
  });
});

describe('elsCommissionDue', () => {
  it('is the rate of a positive GGR, rounded down, and nothing otherwise', () => {
    expect(elsCommissionDue(100_00n, 1500)).toBe(15_00n);
    expect(elsCommissionDue(99n, 1500)).toBe(14n); // 14.85 -> 14
    expect(elsCommissionDue(0n, 1500)).toBe(0n);
    expect(elsCommissionDue(-5_000_00n, 1500)).toBe(0n);
    expect(elsCommissionDue(1_000n, 0)).toBe(0n);
    expect(elsCommissionDue(1_000n, 10_000)).toBe(1_000n);
    expect(() => elsCommissionDue(1n, -1)).toThrow(RangeError);
    expect(() => elsCommissionDue(1n, 10_001)).toThrow(RangeError);
    expect(() => elsCommissionDue(1n, 1.5)).toThrow(RangeError);
  });
});

describe('summarizeDailyTotals', () => {
  it('derives the day from a worked example', () => {
    const { postings } = build([
      { op: 'bet', stake: 100_00n, outcome: 'won', gross: 250_00n, tax: 30_00n, reversed: false },
      { op: 'bet', stake: 50_00n, outcome: 'lost', gross: 0n, tax: 0n, reversed: false },
      { op: 'bet', stake: 20_00n, outcome: 'rejected', gross: 0n, tax: 0n, reversed: false },
      { op: 'jackpot', cost: 10_00n, outcome: 'lost', gross: 0n, tax: 0n },
      { op: 'deposit', amount: 500_00n },
      { op: 'withdrawal', amount: 80_00n, paid: true },
    ]);
    const figures = summarizeDailyTotals(totalsOfPostings(postings), {
      activePlayers: 3,
      commissionRateBps: 1500,
    });
    expect(figures).toMatchObject({
      betStakes: 150_00n,
      betCount: 2,
      jackpotStakes: 10_00n,
      turnover: 160_00n,
      wonPayouts: 250_00n,
      payouts: 250_00n,
      ggr: -90_00n,
      taxWithheld: 30_00n,
      commissionDue: 0n,
      deposits: 500_00n,
      depositCount: 1,
      withdrawals: 80_00n,
      withdrawalCount: 1,
      activePlayers: 3,
    });
  });

  it('matches the figures of the business behind the postings (property)', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 40 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 1000 }),
        (ops, rateBps, activePlayers) => {
          const { postings, expected } = build(ops);
          for (const posting of postings) {
            // The fixtures are real double-entry postings.
            expect(posting.entries.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(0n);
          }
          const figures = summarizeDailyTotals(totalsOfPostings(postings), {
            activePlayers,
            commissionRateBps: rateBps,
          });
          const turnover = expected.betStakes + expected.jackpotStakes;
          const payouts =
            expected.wonPayouts + expected.cashOuts + expected.refunds + expected.jackpotPrizes;
          const ggr = turnover - payouts;
          expect(figures).toEqual({
            ...expected,
            turnover,
            payouts,
            ggr,
            activePlayers,
            commissionRateBps: rateBps,
            commissionDue: ggr > 0n ? (ggr * BigInt(rateBps)) / 10_000n : 0n,
          });

          // Conservation: what players lost to betting is the GGR plus the tax withheld.
          let playerCash = 0n;
          for (const posting of postings) {
            if (!BETTING_TYPES.has(posting.type)) continue;
            for (const entry of posting.entries) {
              if (entry.kind === 'player_cash') playerCash += entry.amount;
            }
          }
          expect(figures.ggr + figures.taxWithheld).toBe(-playerCash);
          expect(figures.commissionDue >= 0n).toBe(true);
          expect(figures.commissionDue <= (figures.ggr > 0n ? figures.ggr : 0n)).toBe(true);
        },
      ),
    );
  });

  it('does not depend on how the postings are grouped or ordered', () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 25 }),
        fc.integer({ min: 0, max: 3 }),
        (ops, cut) => {
          const { postings } = build(ops);
          const input = { activePlayers: 0, commissionRateBps: 1500 };
          const whole = summarizeDailyTotals(totalsOfPostings(postings), input);
          const at = Math.floor((postings.length * cut) / 3);
          const split = summarizeDailyTotals(
            [
              ...totalsOfPostings(postings.slice(at).reverse()),
              ...totalsOfPostings(postings.slice(0, at)),
            ],
            input,
          );
          expect(diffDailyFigures(whole, split)).toEqual([]);
        },
      ),
    );
  });

  it('refuses malformed input', () => {
    expect(() => summarizeDailyTotals([], { activePlayers: -1, commissionRateBps: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      summarizeDailyTotals(
        [
          {
            category: 'bet_stake',
            kind: 'house_stakes',
            amount: 1 as unknown as bigint,
            transactions: 1,
          },
        ],
        { activePlayers: 0, commissionRateBps: 0 },
      ),
    ).toThrow(TypeError);
  });
});

describe('daily summary CSV', () => {
  it('quotes fields that need it and writes santim as integers', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(null)).toBe('');
    expect(csvField(-12n)).toBe('-12');
    expect(csvField(new Date('2026-10-18T21:00:00Z'))).toBe('2026-10-18T21:00:00.000Z');

    const figures = summarizeDailyTotals([], { activePlayers: 0, commissionRateBps: 1500 });
    const row: DailySummaryRow = {
      ...figures,
      businessDate: '2026-10-18',
      status: 'final',
      version: 2,
      windowStart: new Date('2026-10-17T21:00:00Z'),
      windowEnd: new Date('2026-10-18T21:00:00Z'),
      hash: 'abc',
    };
    const csv = dailySummaryCsv([row]);
    const [header, line, end] = csv.split('\r\n');
    expect(
      header?.startsWith('business_date,status,version,window_start,window_end,turnover'),
    ).toBe(true);
    expect(line?.startsWith('2026-10-18,final,2,2026-10-17T21:00:00.000Z,')).toBe(true);
    expect(header?.split(',').length).toBe(line?.split(',').length);
    expect(end).toBe('');
  });
});

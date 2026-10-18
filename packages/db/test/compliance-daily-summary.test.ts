import { birr, DAILY_SUMMARY_FINALIZED, type DailyFigures } from '@vamos/core';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashOutEntries,
  cashOutLedgerKey,
  computeDailyFigures,
  dailySummariesCsv,
  depositEntries,
  depositLedgerKey,
  DomainError,
  finalizeDailySummary,
  getBalance,
  getDailySummary,
  jackpotEntryEntries,
  jackpotEntryLedgerKey,
  jackpotPrizeEntries,
  jackpotPrizeLedgerKey,
  jackpotRefundEntries,
  jackpotRefundLedgerKey,
  negateEntries,
  postTransaction,
  refreshDailySummary,
  refundEntries,
  rejectionLedgerKey,
  reversalLedgerKey,
  runDailySummaries,
  settlementLedgerKey,
  settlementPosting,
  stakeEntries,
  stakeLedgerKey,
  withdrawalHoldEntries,
  withdrawalHoldLedgerKey,
  withdrawalPaidEntries,
  withdrawalPaidLedgerKey,
  type LedgerTransactionType,
  type PostingEntry,
} from '../src/index';
import { auditLog, outboxEvents } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { createUser, dropTestDatabase, errorText, pgCode } from './helpers';

/**
 * The daily summary against the ledger: a two-day history posted with the
 * production posting helpers at fixed times (Addis Ababa days D1 =
 * 2026-10-10 and D2 = 2026-10-11, UTC+3), including a live bet rejected
 * just after midnight and a result correction on the next day. Every
 * expected figure is written from the scenario's own numbers.
 */

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let A: string;
let B: string;
let C: string;

const D0 = '2026-10-09';
const D1 = '2026-10-10';
const D2 = '2026-10-11';
const at = (iso: string) => new Date(iso);

async function post(
  type: LedgerTransactionType,
  idempotencyKey: string,
  entries: PostingEntry[],
  createdAt: Date,
) {
  return handle.db.transaction((tx) =>
    postTransaction(tx, { type, idempotencyKey, entries, createdAt }),
  );
}

const b = (n: string) => `00000000-0000-4000-8000-00000000000${n}`;

beforeAll(async () => {
  handle = await createTestDatabase();
  A = await createUser(handle.db);
  B = await createUser(handle.db);
  C = await createUser(handle.db);
  for (const user of [A, B, C]) {
    await post(
      'demo_topup',
      `topup:${user}`,
      [
        { account: { kind: 'house_demo_funding' }, amount: -birr(10_000) },
        { account: { kind: 'player_cash', userId: user }, amount: birr(10_000) },
      ],
      at('2026-10-09T12:00:00Z'),
    );
  }

  // D1 (2026-10-10 Addis = 2026-10-09T21:00Z .. 2026-10-10T21:00Z).
  await post(
    'bet_stake',
    stakeLedgerKey(A, 'k1'),
    stakeEntries(A, birr(100)),
    at('2026-10-10T07:00:00Z'),
  );
  await post(
    'bet_stake',
    stakeLedgerKey(B, 'k2'),
    stakeEntries(B, birr(50)),
    at('2026-10-10T07:00:00Z'),
  );
  await post(
    'jackpot_entry',
    jackpotEntryLedgerKey(A, 'j1'),
    jackpotEntryEntries(A, birr(10)),
    at('2026-10-10T07:30:00Z'),
  );
  await post(
    'jackpot_entry',
    jackpotEntryLedgerKey(B, 'j2'),
    jackpotEntryEntries(B, birr(10)),
    at('2026-10-10T07:30:00Z'),
  );
  await post(
    'deposit',
    depositLedgerKey(b('1')),
    depositEntries('mock', A, birr(500)),
    at('2026-10-10T08:00:00Z'),
  );
  await post(
    'withdrawal',
    withdrawalHoldLedgerKey(b('2')),
    withdrawalHoldEntries(B, birr(80)),
    at('2026-10-10T08:30:00Z'),
  );
  await post(
    'withdrawal',
    withdrawalPaidLedgerKey(b('2')),
    withdrawalPaidEntries('mock', birr(80)),
    at('2026-10-10T09:00:00Z'),
  );
  // b1 won at 23:30 Addis: gross 250, tax 30; b2 lost.
  const won = settlementPosting(A, birr(100), {
    status: 'won',
    grossPayout: birr(250),
    taxAmount: birr(30),
    netPayout: birr(220),
  });
  await post(won.type, settlementLedgerKey(b('3'), 0), won.entries, at('2026-10-10T20:30:00Z'));
  const lost = settlementPosting(B, birr(50), {
    status: 'lost',
    grossPayout: 0n,
    taxAmount: 0n,
    netPayout: 0n,
  });
  await post(lost.type, settlementLedgerKey(b('4'), 0), lost.entries, at('2026-10-10T20:30:00Z'));
  // A live bet one minute before midnight, rejected one minute after (on D2).
  await post(
    'bet_stake',
    stakeLedgerKey(C, 'k3'),
    stakeEntries(C, birr(20)),
    at('2026-10-10T20:59:00Z'),
  );
  await post(
    'bet_refund',
    rejectionLedgerKey(b('5')),
    refundEntries(C, birr(20)),
    at('2026-10-10T21:01:00Z'),
  );

  // D2: b1's result is corrected to lost (new settlement, then the reversal of the old one).
  const corrected = settlementPosting(A, birr(100), {
    status: 'lost',
    grossPayout: 0n,
    taxAmount: 0n,
    netPayout: 0n,
  });
  await post(
    corrected.type,
    settlementLedgerKey(b('3'), 1),
    corrected.entries,
    at('2026-10-11T06:00:00Z'),
  );
  await post(
    'settlement_reversal',
    reversalLedgerKey(b('3'), 0),
    negateEntries(won.entries),
    at('2026-10-11T06:00:00Z'),
  );
  // b4 void (refunded), b5 cashed out above its stake, A wins a jackpot prize, B's entry refunded.
  await post(
    'bet_stake',
    stakeLedgerKey(B, 'k4'),
    stakeEntries(B, birr(40)),
    at('2026-10-11T07:00:00Z'),
  );
  const voided = settlementPosting(B, birr(40), {
    status: 'void',
    grossPayout: birr(40),
    taxAmount: 0n,
    netPayout: birr(40),
  });
  await post(
    voided.type,
    settlementLedgerKey(b('6'), 0),
    voided.entries,
    at('2026-10-11T08:00:00Z'),
  );
  await post(
    'bet_stake',
    stakeLedgerKey(C, 'k5'),
    stakeEntries(C, birr(60)),
    at('2026-10-11T07:00:00Z'),
  );
  await post(
    'bet_cashout',
    cashOutLedgerKey(b('7')),
    cashOutEntries(C, birr(60), { gross: birr(90), tax: birr(6), net: birr(84) }),
    at('2026-10-11T09:00:00Z'),
  );
  await post(
    'jackpot_prize',
    jackpotPrizeLedgerKey(b('8')),
    jackpotPrizeEntries(A, { gross: birr(100), tax: birr(20), net: birr(80) }),
    at('2026-10-11T10:00:00Z'),
  );
  await post(
    'jackpot_entry',
    jackpotRefundLedgerKey(b('9')),
    jackpotRefundEntries(B, birr(10)),
    at('2026-10-11T10:00:00Z'),
  );
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

/** The expected figures from the scenario's numbers (ETB → santim). */
function expected(input: {
  betStakes: number;
  betCount: number;
  jackpotStakes: number;
  jackpotEntryCount: number;
  wonPayouts: number;
  cashOuts: number;
  refunds: number;
  jackpotPrizes: number;
  taxWithheld: number;
  bonuses: number;
  deposits: number;
  depositCount: number;
  withdrawals: number;
  withdrawalCount: number;
  activePlayers: number;
}): DailyFigures {
  const turnover = birr(input.betStakes + input.jackpotStakes);
  const payouts = birr(input.wonPayouts + input.cashOuts + input.refunds + input.jackpotPrizes);
  const ggr = turnover - payouts;
  return {
    turnover,
    betStakes: birr(input.betStakes),
    betCount: input.betCount,
    jackpotStakes: birr(input.jackpotStakes),
    jackpotEntryCount: input.jackpotEntryCount,
    payouts,
    wonPayouts: birr(input.wonPayouts),
    cashOuts: birr(input.cashOuts),
    refunds: birr(input.refunds),
    jackpotPrizes: birr(input.jackpotPrizes),
    ggr,
    taxWithheld: birr(input.taxWithheld),
    bonuses: birr(input.bonuses),
    deposits: birr(input.deposits),
    depositCount: input.depositCount,
    withdrawals: birr(input.withdrawals),
    withdrawalCount: input.withdrawalCount,
    activePlayers: input.activePlayers,
    commissionRateBps: 1500,
    // floor(GGR x 15%), nothing on a day without positive GGR.
    commissionDue: ggr > 0n ? (ggr * 1500n) / 10_000n : 0n,
  };
}

const D1_FIGURES = expected({
  betStakes: 100 + 50 + 20,
  betCount: 3,
  jackpotStakes: 10 + 10,
  jackpotEntryCount: 2,
  wonPayouts: 250,
  cashOuts: 0,
  refunds: 0,
  jackpotPrizes: 0,
  taxWithheld: 30,
  bonuses: 0,
  deposits: 500,
  depositCount: 1,
  withdrawals: 80,
  withdrawalCount: 1,
  activePlayers: 3,
});

const D2_FIGURES = expected({
  // The live bet rejected after midnight comes off D2's stakes; b4 and b5 are new.
  betStakes: -20 + 40 + 60,
  betCount: -1 + 2,
  jackpotStakes: 0,
  jackpotEntryCount: 0,
  // b1's correction: the new (lost) settlement pays 0, the reversal takes back 250.
  wonPayouts: 0 - 250,
  cashOuts: 90,
  refunds: 40 + 10,
  jackpotPrizes: 100,
  taxWithheld: -30 + 6 + 20,
  bonuses: 0,
  deposits: 0,
  depositCount: 0,
  withdrawals: 0,
  withdrawalCount: 0,
  activePlayers: 2,
});

describe('daily summary figures', () => {
  it('equal the ledger totals of each business day, a correction landing on its own day', async () => {
    const day1 = await computeDailyFigures(handle.db, D1);
    const day2 = await computeDailyFigures(handle.db, D2);
    expect(day1).toEqual(D1_FIGURES);
    expect(day2).toEqual(D2_FIGURES);
    // D1 lost money for the house: no commission. D2: 15% of 90 ETB.
    expect(day1.ggr).toBe(-birr(60));
    expect(day1.commissionDue).toBe(0n);
    expect(day2.ggr).toBe(birr(90));
    expect(day2.commissionDue).toBe(1350n);
  });

  it('add up to what the house accounts hold', async () => {
    const day0 = await computeDailyFigures(handle.db, D0);
    const days = [day0, D1_FIGURES, D2_FIGURES];
    const ggr = days.reduce((sum, day) => sum + day.ggr, 0n);
    const tax = days.reduce((sum, day) => sum + day.taxWithheld, 0n);
    const house =
      (await getBalance(handle.db, { kind: 'house_stakes' })) +
      (await getBalance(handle.db, { kind: 'house_revenue' })) +
      (await getBalance(handle.db, { kind: 'house_jackpot' }));
    expect(ggr).toBe(house);
    expect(tax).toBe(await getBalance(handle.db, { kind: 'house_tax_payable' }));
    expect(day0.turnover).toBe(0n);
  });
});

describe('daily summary storage', () => {
  it('records a version when provisional figures change, and freezes a final day', async () => {
    const now = at('2026-10-11T12:00:00Z');
    const first = await handle.db.transaction((tx) => refreshDailySummary(tx, { date: D1, now }));
    expect(first.outcome).toBe('created');
    expect(first.summary).toMatchObject({ status: 'provisional', version: 1, ...D1_FIGURES });
    const again = await handle.db.transaction((tx) => refreshDailySummary(tx, { date: D1, now }));
    expect(again).toMatchObject({ outcome: 'unchanged', summary: { version: 1 } });

    // A late bonus posted inside D1 changes D1 while it is provisional.
    await post(
      'bonus',
      'bonus:late:1',
      [
        { account: { kind: 'house_promotions' }, amount: -birr(5) },
        { account: { kind: 'player_bonus', userId: A }, amount: birr(5) },
      ],
      at('2026-10-10T12:00:00Z'),
    );
    const recomputed = await handle.db.transaction((tx) =>
      refreshDailySummary(tx, { date: D1, now, actor: 'staff-1' }),
    );
    expect(recomputed.outcome).toBe('recomputed');
    expect(recomputed.summary).toMatchObject({ version: 2, bonuses: birr(5) });
    const detail = await getDailySummary(handle.db, D1);
    expect(detail.versions.map((v) => [v.version, v.reason, v.computedBy])).toEqual([
      [1, 'computed', 'system'],
      [2, 'recomputed', 'staff-1'],
    ]);

    // Not before the day's end plus its grace period.
    const early = await handle.db
      .transaction((tx) =>
        finalizeDailySummary(tx, {
          date: D1,
          now: at('2026-10-10T22:00:00Z'),
          graceMs: 2 * 3_600_000,
        }),
      )
      .catch((error: unknown) => error);
    expect(early).toBeInstanceOf(DomainError);
    expect(early).toMatchObject({ status: 422, code: 'summary_not_due' });

    const finalizedAt = at('2026-10-11T00:00:00Z');
    const final = await handle.db.transaction((tx) =>
      finalizeDailySummary(tx, { date: D1, now: finalizedAt, graceMs: 2 * 3_600_000 }),
    );
    expect(final.changed).toBe(true);
    expect(final.summary).toMatchObject({
      status: 'final',
      version: 2,
      finalizedBy: 'system',
      ggr: D1_FIGURES.ggr,
      commissionDue: 0n,
    });
    const events = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, DAILY_SUMMARY_FINALIZED), eq(outboxEvents.aggregateId, D1)));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      businessDate: D1,
      version: 2,
      turnover: D1_FIGURES.turnover.toString(),
      ggr: D1_FIGURES.ggr.toString(),
      commissionDue: '0',
      hash: final.summary.hash,
    });
    const audits = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.targetType, 'daily_summary'), eq(auditLog.targetId, D1)));
    expect(audits.map((row) => row.action)).toEqual([DAILY_SUMMARY_FINALIZED]);

    // A later posting dated D1 no longer changes it, and finalising again does nothing.
    await post(
      'bonus',
      'bonus:late:2',
      [
        { account: { kind: 'house_promotions' }, amount: -birr(7) },
        { account: { kind: 'player_bonus', userId: A }, amount: birr(7) },
      ],
      at('2026-10-10T13:00:00Z'),
    );
    const frozen = await handle.db.transaction((tx) =>
      refreshDailySummary(tx, { date: D1, now: at('2026-10-11T05:00:00Z') }),
    );
    expect(frozen.outcome).toBe('final');
    expect(frozen.summary.bonuses).toBe(birr(5));
    const twice = await handle.db.transaction((tx) =>
      finalizeDailySummary(tx, { date: D1, now: at('2026-10-11T05:00:00Z') }),
    );
    expect(twice.changed).toBe(false);
  });

  it('refuses changes to a final summary and to recorded versions in the database', async () => {
    for (const statement of [
      sql`UPDATE daily_summaries SET turnover = 0, bet_stakes = 0, jackpot_stakes = 0 WHERE business_date = ${D1}`,
      sql`DELETE FROM daily_summaries WHERE business_date = ${D1}`,
      sql`UPDATE daily_summary_versions SET reason = 'edited' WHERE business_date = ${D1}`,
      sql`DELETE FROM daily_summary_versions WHERE business_date = ${D1}`,
    ]) {
      const error = await handle.db.execute(statement).catch((caught: unknown) => caught);
      expect(pgCode(error), errorText(error)).toBe('23001');
    }
  });

  it('does not compute a day that has not started', async () => {
    const error = await handle.db
      .transaction((tx) =>
        refreshDailySummary(tx, { date: '2026-10-20', now: at('2026-10-19T20:59:59Z') }),
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 422, code: 'summary_not_started' });
  });

  it('finalises every due day in the worker run and lists them as CSV', async () => {
    const now = at('2026-10-12T00:00:00Z');
    const run = await runDailySummaries(handle.db, { now });
    // D0 (the first posting) and D2 are due; D1 is final already; 2026-10-12 is today.
    expect(run).toEqual({ finalized: [D0, D2], refreshed: ['2026-10-12'] });
    const day2 = await getDailySummary(handle.db, D2);
    expect(day2.summary).toMatchObject({ status: 'final', version: 1, ...D2_FIGURES });
    expect(await runDailySummaries(handle.db, { now })).toEqual({
      finalized: [],
      refreshed: ['2026-10-12'],
    });

    const csv = await dailySummariesCsv(handle.db, { from: D0, to: D2 });
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    const header = lines[0]!.split(',');
    const row2 = Object.fromEntries(lines[3]!.split(',').map((value, i) => [header[i], value]));
    expect(row2).toMatchObject({
      business_date: D2,
      status: 'final',
      turnover: D2_FIGURES.turnover.toString(),
      payouts: D2_FIGURES.payouts.toString(),
      ggr: '9000',
      tax_withheld: D2_FIGURES.taxWithheld.toString(),
      commission_rate_bps: '1500',
      commission_due: '1350',
    });
  });
});

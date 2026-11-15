import { randomUUID } from 'node:crypto';
import { addBusinessDays, birr, businessDateOf, businessDayWindow } from '@vamos/core';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getPspStatement,
  getReconciliationRun,
  importPspStatement,
  listPspStatements,
  listReconciliationRuns,
  markPayoutPaid,
  postTransaction,
  RECONCILIATION_CHECKS,
  RECONCILIATION_MISMATCH,
  rejectWithdrawal,
  runReconciliation,
  settleEventBets,
  type GameSettings,
  type ReconciliationRunDetail,
  runReconciliationChecks,
} from '../src/index';
import { auditLog, outboxEvents, paymentIntents, payouts } from '../src/schema/index';
import { createBettingDatabase, createEvent, finish, place, type TestDb } from './betting-fixtures';
import { dropTestDatabase } from './helpers';
import { createPlayer, depositViaMock, domainError, NOW, withdraw } from './payments-fixtures';

/**
 * Reconciliation on a real dataset built with the services (deposits through
 * the mock provider, bets placed and settled, withdrawals paid and
 * rejected): a clean dataset passes every check; each injected difference
 * (a corrupted cached balance, money through the PSP account without a
 * payout, a posting into a finalised day, a statement line with a wrong
 * amount, a paid payout missing from the statement, an unknown line) is
 * found.
 */

let handle: TestDb;
let settings: GameSettings;
const ADMIN = { adminId: '0f0e0d0c-0b0a-4908-8706-050403020100' };
let playerId: string;

const run = (overrides: Partial<Parameters<typeof runReconciliation>[1]> = {}) =>
  runReconciliation(handle.db, { now: new Date(), actor: ADMIN, ...overrides });

function failing(detail: ReconciliationRunDetail) {
  return detail.run.checks.filter((check) => !check.ok).map((check) => check.check);
}

beforeAll(async () => {
  let catalog: Awaited<ReturnType<typeof createBettingDatabase>>['ids'];
  ({ handle, settings, ids: catalog } = await createBettingDatabase());
  const player = await createPlayer(handle.db);
  const other = await createPlayer(handle.db);
  playerId = player.userId;
  await depositViaMock(handle.db, player.userId, birr(1_000));
  await depositViaMock(handle.db, other.userId, birr(300));
  // A bet that wins and one that stays open.
  const event = await createEvent(handle.db, catalog);
  const open = await createEvent(handle.db, catalog);
  await place(handle.db, player.userId, {
    stake: birr(100),
    legs: [{ selectionId: event.home, oddsMilli: 2000 }],
    settings,
  });
  await place(handle.db, other.userId, {
    stake: birr(50),
    legs: [{ selectionId: open.away, oddsMilli: 3500 }],
    settings,
  });
  await finish(handle.db, event.eventId, 2, 1);
  await handle.db.transaction((tx) => settleEventBets(tx, event.eventId, new Date()));
  // One withdrawal paid, one rejected.
  const paid = await withdraw(handle.db, player, birr(150));
  await handle.db.transaction((tx) =>
    markPayoutPaid(tx, { payoutId: paid.payout.id, providerRef: 'MOCKPAY-1', now: NOW }),
  );
  const rejected = await withdraw(handle.db, other, birr(60));
  await handle.db.transaction((tx) =>
    rejectWithdrawal(tx, {
      payoutId: rejected.payout.id,
      adminId: ADMIN.adminId,
      reason: 'test',
      now: NOW,
    }),
  );
});

afterAll(async () => {
  await dropTestDatabase(handle);
});

describe('reconciliation', () => {
  it('finds nothing wrong in a clean dataset', async () => {
    const detail = await run();
    expect(failing(detail)).toEqual([]);
    expect(detail.run).toMatchObject({
      kind: 'manual',
      status: 'clean',
      mismatchCount: 0,
      triggeredBy: ADMIN.adminId,
      businessDate: businessDateOf(new Date()),
    });
    expect(detail.run.checks.map((check) => check.check)).toEqual([...RECONCILIATION_CHECKS]);
    const checked = Object.fromEntries(
      detail.run.checks.map((check) => [check.check, check.checked]),
    );
    // It looked at the payments of the day: 2 deposits and 1 payout.
    expect(checked.psp_movements).toBe(3);
    expect(checked.psp_records).toBe(3);
    expect(detail.mismatches).toEqual([]);
    const audits = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, detail.run.id));
    expect(audits.map((row) => row.action)).toEqual(['reconciliation.run']);
    // A scheduled run checks yesterday's payments by default.
    const scheduled = await runReconciliation(handle.db, { now: new Date() });
    expect(scheduled.run).toMatchObject({
      kind: 'scheduled',
      status: 'clean',
      triggeredBy: 'system',
      businessDate: addBusinessDays(businessDateOf(new Date()), -1),
    });
  });

  it('detects a corrupted cached balance, and is clean again once it is repaired', async () => {
    const corrupt = (delta: number) =>
      handle.db.transaction(async (tx) => {
        await tx.execute(
          sql`ALTER TABLE ledger_accounts DISABLE TRIGGER ledger_accounts_balance_matches`,
        );
        await tx.execute(
          sql`UPDATE ledger_accounts SET balance = balance + ${delta} WHERE key = ${`user:${playerId}:cash`}`,
        );
        await tx.execute(
          sql`ALTER TABLE ledger_accounts ENABLE TRIGGER ledger_accounts_balance_matches`,
        );
      });
    await corrupt(1);
    const detail = await run();
    expect(detail.run.status).toBe('mismatches');
    expect(failing(detail)).toEqual(['wallet']);
    const [mismatch] = detail.mismatches;
    expect(mismatch).toMatchObject({ check: 'wallet', subjectType: 'player', subjectId: playerId });
    expect(BigInt(mismatch!.actual!) - BigInt(mismatch!.expected!)).toBe(1n);
    // The alert: an outbox event and an audit record.
    const alerts = await handle.db
      .select({ payload: outboxEvents.payload })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, RECONCILIATION_MISMATCH),
          eq(outboxEvents.aggregateId, detail.run.id),
        ),
      );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({ mismatchCount: 1, checks: ['wallet'] });
    const audits = await handle.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetId, detail.run.id));
    expect(audits.map((row) => row.action).sort()).toEqual([
      'reconciliation.mismatch_detected',
      'reconciliation.run',
    ]);

    // Each check reads the ledger once: no second pass to count once the cap is reached, and no
    // per-account array of every entry.
    const statements: string[] = [];
    const dialect = new PgDialect();
    const counting = new Proxy(handle.db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return (query: SQL) => {
            statements.push(dialect.sqlToQuery(query).sql);
            return target.execute(query);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const businessDate = businessDateOf(new Date());
    const wide = await runReconciliationChecks(counting, { businessDate });
    const wideCount = statements.length;
    statements.length = 0;
    const narrow = await runReconciliationChecks(counting, {
      businessDate,
      maxMismatchesPerCheck: 1,
    });
    expect(narrow.checks).toEqual(wide.checks);
    expect(narrow.checks.find((check) => check.check === 'wallet')?.mismatches).toBe(1);
    expect(statements.length).toBe(wideCount);
    expect(statements.some((text) => text.includes('array_agg'))).toBe(false);

    await corrupt(-1);
    expect((await run()).run.status).toBe('clean');
  });

  it('detects money moved through the PSP account without a payout', async () => {
    const posting = await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'withdrawal',
        idempotencyKey: `withdrawal:${randomUUID()}:paid`,
        refType: 'payout',
        refId: randomUUID(),
        entries: [
          { account: { kind: 'house_withdrawals_pending' }, amount: -birr(25) },
          { account: { kind: 'house_psp_clearing', provider: 'mock' }, amount: birr(25) },
        ],
      }),
    );
    const detail = await run();
    expect(failing(detail).sort()).toEqual(
      ['house_withdrawals_pending', 'psp_daily_totals', 'psp_movements'].sort(),
    );
    expect(detail.mismatches).toContainEqual(
      expect.objectContaining({
        check: 'psp_movements',
        subjectType: 'ledger_transaction',
        subjectId: posting.transactionId,
        actual: birr(25).toString(),
      }),
    );
    expect(detail.mismatches).toContainEqual(
      expect.objectContaining({
        check: 'psp_daily_totals',
        subjectId: `mock:${businessDateOf(new Date())}`,
        expected: birr(150).toString(),
        actual: birr(175).toString(),
      }),
    );
    expect(detail.mismatches).toContainEqual(
      expect.objectContaining({
        check: 'house_withdrawals_pending',
        expected: '0',
        actual: (-birr(25)).toString(),
      }),
    );
  });

  it('detects a stake posted yesterday with no bet behind it', async () => {
    const yesterday = addBusinessDays(businessDateOf(new Date()), -1);
    await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'bet_stake',
        idempotencyKey: `late:${randomUUID()}`,
        entries: [
          { account: { kind: 'player_cash', userId: playerId }, amount: -birr(1) },
          { account: { kind: 'house_stakes' }, amount: birr(1) },
        ],
        createdAt: new Date(businessDayWindow(yesterday).start.getTime() + 3_600_000),
      }),
    );
    const detail = await run();
    expect(failing(detail)).toContain('house_stakes');
    const listed = await listReconciliationRuns(handle.db, { limit: 2 });
    expect(listed.items[0]?.id).toBe(detail.run.id);
    expect(listed.nextCursor).not.toBeNull();
    const again = await getReconciliationRun(handle.db, detail.run.id);
    expect(again.mismatches).toHaveLength(detail.mismatches.length);
    const next = await listReconciliationRuns(handle.db, {
      limit: 2,
      cursor: listed.nextCursor!,
    });
    expect(next.items[0]?.id).not.toBe(detail.run.id);
  });
});

/** Every deposit and payout of the mock provider as statement lines (birr). */
async function statementLines(): Promise<
  Array<{ reference: string; amount: bigint; type: 'deposit' | 'payout' }>
> {
  const intents = await handle.db
    .select({ reference: paymentIntents.providerRef, amount: paymentIntents.amount })
    .from(paymentIntents)
    .where(and(eq(paymentIntents.provider, 'mock'), eq(paymentIntents.status, 'succeeded')));
  const paid = await handle.db
    .select({ reference: payouts.providerRef, amount: payouts.amount })
    .from(payouts)
    .where(and(eq(payouts.provider, 'mock'), eq(payouts.status, 'paid')));
  return [
    ...intents.map((row) => ({
      reference: row.reference!,
      amount: row.amount,
      type: 'deposit' as const,
    })),
    ...paid.map((row) => ({
      reference: row.reference!,
      amount: -row.amount,
      type: 'payout' as const,
    })),
  ];
}

const birrText = (santim: bigint) => {
  const negative = santim < 0n;
  const abs = negative ? -santim : santim;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};

function csvOf(lines: Array<{ reference: string; amount: bigint; type: string }>): string {
  return [
    'provider,reference,amount,date,type',
    ...lines.map(
      (line) => `mock,${line.reference},${birrText(line.amount)},2026-10-10,${line.type}`,
    ),
  ].join('\n');
}

describe('PSP statements', () => {
  it('matches a statement that agrees with our records line for line', async () => {
    const lines = await statementLines();
    expect(lines).toHaveLength(3);
    const csv = csvOf(lines);
    const result = await importPspStatement(handle.db, {
      csv,
      fileName: 'mock-2026-10-10.csv',
      provider: 'mock',
      actor: ADMIN,
      now: NOW,
    });
    expect(result.run).toMatchObject({ kind: 'psp_statement', status: 'clean', mismatchCount: 0 });
    expect(result.lines.map((line) => line.matchStatus)).toEqual(['matched', 'matched', 'matched']);
    expect(result.statement).toMatchObject({
      providers: ['mock'],
      periodFrom: '2026-10-10',
      periodTo: '2026-10-10',
      lineCount: 3,
      totalIn: birr(1_300),
      totalOut: birr(150),
    });
    // The same file twice is refused.
    const duplicate = await domainError(
      importPspStatement(handle.db, { csv, actor: ADMIN, now: NOW }),
    );
    expect(duplicate).toMatchObject({ status: 409, code: 'statement_already_imported' });
  });

  it('finds a wrong amount, a missing payout and an unknown line', async () => {
    const lines = await statementLines();
    const deposits = lines.filter((line) => line.type === 'deposit');
    const csv = csvOf([
      { ...deposits[0]!, amount: deposits[0]!.amount + birr(1) },
      deposits[1]!,
      // The paid payout is left out; a line we know nothing about is added.
      { reference: 'MOCK-UNKNOWN', amount: birr(42), type: 'deposit' },
    ]);
    const later = new Date(NOW.getTime() + 60_000);
    const result = await importPspStatement(handle.db, { csv, actor: ADMIN, now: later });
    expect(result.run).toMatchObject({ status: 'mismatches', mismatchCount: 3 });
    expect(result.lines.map((line) => line.matchStatus)).toEqual([
      'amount_mismatch',
      'matched',
      'unmatched',
    ]);
    const [paidPayout] = await handle.db
      .select({ id: payouts.id })
      .from(payouts)
      .where(eq(payouts.status, 'paid'));
    expect(result.mismatches).toContainEqual(
      expect.objectContaining({
        check: 'psp_statement',
        subjectType: 'payout',
        subjectId: paidPayout!.id,
        expected: birr(150).toString(),
        actual: null,
      }),
    );
    expect(
      result.mismatches.map((mismatch) => (mismatch.details as { status: string }).status).sort(),
    ).toEqual(['amount_mismatch', 'missing_from_statement', 'unmatched'].sort());
    const alerts = await handle.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.type, RECONCILIATION_MISMATCH),
          eq(outboxEvents.aggregateId, result.run.id),
        ),
      );
    expect(alerts).toHaveLength(1);

    const listed = await listPspStatements(handle.db, { provider: 'mock' });
    expect(listed.items[0]).toMatchObject({
      id: result.statement.id,
      status: 'mismatches',
      mismatchCount: 3,
      runId: result.run.id,
    });
    const detail = await getPspStatement(handle.db, result.statement.id);
    expect(detail.lines).toHaveLength(3);
    expect(detail.runId).toBe(result.run.id);
  });

  it('refuses a statement that cannot be read or is of another provider', async () => {
    const bad = await domainError(
      importPspStatement(handle.db, {
        csv: 'provider,reference,amount,date\nmock,R1,12.345,2026-10-10\nmock,R2,1,2026-02-30',
        actor: ADMIN,
        now: NOW,
      }),
    );
    expect(bad).toMatchObject({ status: 422, code: 'invalid_statement' });
    expect(
      (bad.details as { errors: Array<{ lineNo: number }> }).errors.map((e) => e.lineNo),
    ).toEqual([2, 3]);
    const other = await domainError(
      importPspStatement(handle.db, {
        csv: 'provider,reference,amount,date\nmock,R1,10,2026-10-10',
        provider: 'chapa',
        actor: ADMIN,
        now: NOW,
      }),
    );
    expect(other).toMatchObject({ status: 422, code: 'invalid_statement' });
  });
});

import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { birr, DAILY_SUMMARY_FINALIZED } from '@vamos/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFileElsReporter,
  createHttpElsReporter,
  createOffElsReporter,
  dailySummaryRowOf,
  elsLineHash,
  emitElsEvent,
  enqueueOutbox,
  finalizeDailySummary,
  getElsReportStatus,
  postTransaction,
  recordElsEvent,
  sweepElsReports,
  type ElsReporter,
} from '../src/index';
import { dailySummaries, elsReports } from '../src/schema/index';
import { createTestDatabase } from '../src/testing';
import { createUser, dropTestDatabase, errorText, pgCode } from './helpers';

let handle: Awaited<ReturnType<typeof createTestDatabase>>;
let dir: string;
let reporter: ElsReporter;
let userId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'vamos-els-'));
  reporter = createFileElsReporter({ dir });
  userId = await createUser(handle.db);
});

afterAll(async () => {
  await dropTestDatabase(handle);
  await rm(dir, { recursive: true, force: true });
});

async function dailyRowOf(date: string) {
  const [summary] = await handle.db
    .select()
    .from(dailySummaries)
    .where(eq(dailySummaries.businessDate, date));
  return dailySummaryRowOf(summary!);
}

async function deposit(intentId: string, amount = 150_000n): Promise<bigint> {
  return enqueueOutbox(handle.db, {
    type: 'payment.deposit_succeeded',
    aggregateType: 'payment_intent',
    aggregateId: intentId,
    payload: {
      intentId,
      userId,
      provider: 'mock',
      amount,
      providerRef: `MOCK-${intentId}`,
      // Never copied into the stream.
      phone: '+251911223344',
    },
  });
}

async function report(outboxId: bigint) {
  const [row] = await handle.db.select().from(elsReports).where(eq(elsReports.outboxId, outboxId));
  return row;
}

/** Every line of every stream file (by business date). */
async function streamLines(date: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, 'stream', `${date}.jsonl`), 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function dateOf(outboxId: bigint): Promise<string> {
  return (await report(outboxId))!.businessDate;
}

describe('ELS emission', () => {
  it('writes each reportable event once, whatever the replays', async () => {
    const id = await deposit('i-1');
    const first = await emitElsEvent(handle.db, reporter, { outboxId: id });
    expect(first.outcome).toBe('written');
    const again = await emitElsEvent(handle.db, reporter, { outboxId: id.toString() });
    expect(again.outcome).toBe('already_written');
    // Concurrent deliveries of another event: one line.
    const id2 = await deposit('i-2');
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => emitElsEvent(handle.db, reporter, { outboxId: id2 })),
    );
    expect(outcomes.filter((outcome) => outcome.outcome === 'written')).toHaveLength(1);

    const date = await dateOf(id);
    const lines = await streamLines(date);
    expect(lines.filter((line) => line.includes(`"outboxId":"${id}"`))).toHaveLength(1);
    expect(lines.filter((line) => line.includes(`"outboxId":"${id2}"`))).toHaveLength(1);
    const row = await report(id);
    expect(row).toMatchObject({ status: 'written', playerRef: userId, attempts: 1 });
    expect(row?.location).toBe(join('stream', `${date}.jsonl`));
    expect(lines).toContain(row!.line);
    expect(row!.hash).toBe(elsLineHash(row!.line));
    // Data minimisation: the pseudonymous id and the amount, no phone number.
    const record = JSON.parse(row!.line) as Record<string, unknown>;
    expect(record).toMatchObject({
      type: 'payment.deposit_succeeded',
      playerRef: userId,
      data: { amount: '150000', provider: 'mock' },
    });
    expect(row!.line).not.toContain('251911223344');
  });

  it('skips what is not reported and what does not exist', async () => {
    const id = await enqueueOutbox(handle.db, {
      type: 'payment.withdrawal_requested',
      aggregateType: 'payout',
      aggregateId: 'p',
      payload: { userId },
    });
    expect((await emitElsEvent(handle.db, reporter, { outboxId: id })).outcome).toBe(
      'not_reportable',
    );
    expect(await report(id)).toBeUndefined();
    expect((await emitElsEvent(handle.db, reporter, { outboxId: 999_999n })).outcome).toBe(
      'not_found',
    );
    const off = await emitElsEvent(handle.db, createOffElsReporter(), { outboxId: id });
    expect(off.outcome).toBe('disabled');
  });

  it('does not repeat a line whose write was not confirmed, and drops a torn line', async () => {
    const id = await deposit('i-3');
    // A first attempt wrote the line but died before marking it written.
    await recordElsEvent(handle.db, id);
    await handle.db.update(elsReports).set({ attempts: 1 }).where(eq(elsReports.outboxId, id));
    const row = (await report(id))!;
    await appendFile(join(dir, 'stream', `${row.businessDate}.jsonl`), `${row.line}\n`);
    const recovered = await emitElsEvent(handle.db, reporter, { outboxId: id });
    expect(recovered.outcome).toBe('written');
    expect((await streamLines(row.businessDate)).filter((line) => line === row.line)).toHaveLength(
      1,
    );

    // A crash mid-write left half a line: it is cut off before the next record.
    await appendFile(
      join(dir, 'stream', `${row.businessDate}.jsonl`),
      '{"schema":"vamos.els.v1","out',
    );
    const id4 = await deposit('i-4');
    expect((await emitElsEvent(handle.db, reporter, { outboxId: id4 })).outcome).toBe('written');
    const lines = await streamLines(row.businessDate);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it('keeps records pending while the HTTP placeholder cannot send, and sweeps them later', async () => {
    const id = await deposit('i-5');
    const http = createHttpElsReporter({ url: 'https://els.example/report' });
    const refused = await emitElsEvent(handle.db, http, { outboxId: id });
    expect(refused.outcome).toBe('unavailable');
    expect(await report(id)).toMatchObject({ status: 'pending' });
    expect((await report(id))?.lastError).toMatch(/has not published/);
    expect((await http.status()).ready).toBe(false);

    // A lost job: an event no consumer ever saw.
    const lost = await deposit('i-6');
    const swept = await sweepElsReports(handle.db, reporter, { graceMs: 0 });
    expect(swept.recorded).toBeGreaterThanOrEqual(1);
    expect(swept.written).toBeGreaterThanOrEqual(2);
    expect(swept.failed).toBe(0);
    expect(await report(id)).toMatchObject({ status: 'written' });
    expect(await report(lost)).toMatchObject({ status: 'written' });
    const again = await sweepElsReports(handle.db, reporter, { graceMs: 0 });
    expect(again).toEqual({ recorded: 0, written: 0, pending: 0, failed: 0 });
    const lines = await streamLines(await dateOf(lost));
    expect(lines.filter((line) => line.includes(`"outboxId":"${lost}"`))).toHaveLength(1);

    const status = await getElsReportStatus(handle.db, { reporter });
    expect(status).toMatchObject({
      pending: 0,
      lastError: null,
      reporter: { mode: 'file', ready: true },
    });
    expect(status.written).toBeGreaterThanOrEqual(6);
  });

  it('writes a finalised daily summary as a stream record and a CSV file', async () => {
    const date = '2026-10-10';
    await handle.db.transaction((tx) =>
      postTransaction(tx, {
        type: 'demo_topup',
        idempotencyKey: 'els:topup',
        entries: [
          { account: { kind: 'house_demo_funding' }, amount: -birr(1) },
          { account: { kind: 'player_cash', userId }, amount: birr(1) },
        ],
        createdAt: new Date('2026-10-10T08:00:00Z'),
      }),
    );
    await handle.db.transaction((tx) =>
      finalizeDailySummary(tx, { date, now: new Date('2026-10-11T00:00:00Z') }),
    );
    const swept = await sweepElsReports(handle.db, reporter, { graceMs: 0 });
    expect(swept.written).toBe(1);
    const [row] = await handle.db
      .select()
      .from(elsReports)
      .where(eq(elsReports.type, DAILY_SUMMARY_FINALIZED));
    expect(JSON.parse(row!.line)).toMatchObject({
      type: DAILY_SUMMARY_FINALIZED,
      playerRef: null,
      data: { businessDate: date, turnover: '0', commissionDue: '0', version: 1 },
    });
    const csv = await readFile(join(dir, 'daily', `${date}.csv`), 'utf8');
    const [header, line] = csv.split('\r\n');
    expect(header).toMatch(/^business_date,status,version,/);
    expect(line).toMatch(/^2026-10-10,final,1,/);
    // Personal data: only the worker's user may read the folders and files (umask notwithstanding).
    const previous = process.umask(0o022);
    try {
      const fresh = createFileElsReporter({ dir: join(dir, 'fresh', 'els') });
      await fresh.writeRecord(
        { outboxId: '1', businessDate: date, line: '{"x":1}' },
        { recheck: false },
      );
      await fresh.writeDailySummary(await dailyRowOf(date));
      const modeOf = async (path: string) => (await stat(join(dir, 'fresh', path))).mode & 0o777;
      expect(await modeOf('els')).toBe(0o700);
      expect(await modeOf('els/stream')).toBe(0o700);
      expect(await modeOf('els/daily')).toBe(0o700);
      expect(await modeOf(`els/stream/${date}.jsonl`)).toBe(0o600);
      expect(await modeOf(`els/daily/${date}.csv`)).toBe(0o600);
      expect((await fresh.status()).detail).not.toMatch(/readable/);
      await chmod(join(dir, 'fresh', 'els'), 0o755);
      expect((await fresh.status()).detail).toMatch(/readable by other users/);
    } finally {
      process.umask(previous);
    }
  });

  it('keeps a written record as it is in the database', async () => {
    const [row] = await handle.db.select().from(elsReports).limit(1);
    for (const statement of [
      sql`UPDATE els_reports SET line = 'x' WHERE outbox_id = ${row!.outboxId}`,
      sql`UPDATE els_reports SET status = 'pending', written_at = NULL WHERE outbox_id = ${row!.outboxId}`,
      sql`DELETE FROM els_reports WHERE outbox_id = ${row!.outboxId}`,
    ]) {
      const error = await handle.db.execute(statement).catch((caught: unknown) => caught);
      expect(pgCode(error), errorText(error)).toBe('23001');
    }
  });

  it('writes nothing with reporting off', async () => {
    const id = await deposit('i-7');
    expect(await sweepElsReports(handle.db, createOffElsReporter(), { graceMs: 0 })).toEqual({
      recorded: 0,
      written: 0,
      pending: 0,
      failed: 0,
    });
    expect(await report(id)).toBeUndefined();
    // A stray file in the directory does not disturb the stream.
    await writeFile(join(dir, 'README'), 'not a stream file');
  });
});

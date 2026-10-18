import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildElsRecord,
  dailySummaryCsv,
  DAILY_SUMMARY_FINALIZED,
  elsRecordLine,
  ELS_REPORTABLE_TYPES,
  isBusinessDate,
  type DailySummaryRow,
} from '@vamos/core';
import { and, asc, count, eq, gt, inArray, lt, max, min, sql } from 'drizzle-orm';
import type { Database } from '../client';
import type { DbExecutor } from '../ledger/types';
import { complianceCursors, dailySummaries, elsReports } from '../schema/compliance';
import { outboxEvents } from '../schema/platform';
import { dailySummaryRowOf } from './daily-summary';

/**
 * The regulator (Ethiopian Lottery Service) transaction stream. Reportable
 * outbox events (core ELS_REPORTABLE_TYPES: bets placed / accepted /
 * rejected / settled / cashed out / reopened, jackpot entries and their
 * settlement, deposits credited, withdrawals paid, finalised daily
 * summaries) reach the worker's `els` queue through the outbox dispatcher;
 * the consumer calls emitElsEvent with the row id.
 *
 * Exactly once per outbox id: the record (canonical JSON line and its
 * SHA-256) is first stored in els_reports (pending), then written by the
 * reporter and marked written. A redelivered job, a restart or the sweep
 * finds it written and does nothing; a write that may have happened but
 * was not confirmed (crash, lost commit) is retried with `recheck`, so the
 * reporter first looks whether the line is already in the stream. Writes
 * are serialised across processes by a Postgres advisory lock.
 *
 * Data minimisation (Personal Data Protection Proclamation No. 1321/2024):
 * a record carries the pseudonymous player id (the internal account UUID)
 * and santim amounts, never names, phone numbers, ID documents or IP
 * addresses (each event type has a field whitelist in @vamos/core els).
 */

export type ElsReport = typeof elsReports.$inferSelect;
export type ElsReportingMode = 'file' | 'http' | 'off';

/** The reporter cannot deliver now (the HTTP placeholder, or reporting off). Nothing was sent. */
export class ElsReportingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElsReportingUnavailableError';
  }
}

export interface ElsReporterStatus {
  mode: ElsReportingMode;
  /** Whether it can deliver records now. */
  ready: boolean;
  detail: string;
  /** The directory or URL it delivers to. */
  target: string | null;
}

/** Where ELS records and daily summaries go. Callers serialise writes (emitElsEvent does). */
export interface ElsReporter {
  readonly mode: ElsReportingMode;
  /**
   * Appends one record line to the stream of its business date. With
   * `recheck` (a retry after a write that was not confirmed) it first looks
   * for the identical line and does not append it again when it is there.
   * Throws ElsReportingUnavailableError when it cannot deliver.
   */
  writeRecord(
    record: { outboxId: string; businessDate: string; line: string },
    options: { recheck: boolean },
  ): Promise<{ location: string; alreadyPresent: boolean }>;
  /** Writes (replaces) the CSV of a finalised daily summary. */
  writeDailySummary(row: DailySummaryRow): Promise<{ location: string }>;
  status(): Promise<ElsReporterStatus>;
}

const STREAM_DIR = 'stream';
const DAILY_DIR = 'daily';
/** Personal data (PDPP): folders and files only the worker's user can read. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function assertDateName(date: string): void {
  // The date names a file: only a real YYYY-MM-DD may.
  if (!isBusinessDate(date)) throw new RangeError(`invalid business date: ${String(date)}`);
}

/**
 * The file reporter: `<dir>/stream/<YYYY-MM-DD>.jsonl` (one canonical JSON
 * record per line, by the event's Addis Ababa business date) and
 * `<dir>/daily/<YYYY-MM-DD>.csv` (the day's final summary, header + one
 * row, amounts in santim). Appends are single writes to a file opened for
 * appending; a line cut short by a crash (no final newline) is cut off
 * before the next append, so the stream only ever holds whole records.
 */
export function createFileElsReporter(options: { dir: string }): ElsReporter {
  const { dir } = options;
  const streamPath = (date: string) => join(dir, STREAM_DIR, `${date}.jsonl`);
  return {
    mode: 'file',
    async writeRecord(record, { recheck }) {
      assertDateName(record.businessDate);
      if (record.line.includes('\n')) throw new RangeError('an ELS record line has no line break');
      const path = streamPath(record.businessDate);
      const location = join(STREAM_DIR, `${record.businessDate}.jsonl`);
      await mkdir(join(dir, STREAM_DIR), { recursive: true, mode: DIR_MODE });
      let size = 0;
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (size > 0) {
        const handle = await open(path, 'r');
        try {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 0x0a) {
            // A record cut short by a crash: drop the fragment (it was never a whole record).
            const content = await readFile(path);
            const keep = content.lastIndexOf(0x0a) + 1;
            await truncate(path, keep);
            size = keep;
          }
        } finally {
          await handle.close();
        }
      }
      if (recheck && size > 0) {
        const lines = (await readFile(path, 'utf8')).split('\n');
        if (lines.includes(record.line)) return { location, alreadyPresent: true };
      }
      const handle = await open(path, 'a', FILE_MODE);
      try {
        await handle.write(`${record.line}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { location, alreadyPresent: false };
    },
    async writeDailySummary(row) {
      assertDateName(row.businessDate);
      await mkdir(join(dir, DAILY_DIR), { recursive: true, mode: DIR_MODE });
      const name = `${row.businessDate}.csv`;
      const path = join(dir, DAILY_DIR, name);
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, dailySummaryCsv([row]), {
        encoding: 'utf8',
        flush: true,
        mode: FILE_MODE,
      });
      await rename(temporary, path);
      return { location: join(DAILY_DIR, name) };
    },
    async status() {
      try {
        await mkdir(dir, { recursive: true, mode: DIR_MODE });
        const exposed = ((await stat(dir)).mode & 0o077) !== 0;
        const detail = exposed
          ? `writing JSONL and CSV files (warning: ${dir} is readable by other users; chmod 700 it)`
          : 'writing JSONL and CSV files';
        return { mode: 'file', ready: true, detail, target: dir };
      } catch (error) {
        return {
          mode: 'file',
          ready: false,
          detail: `cannot use ${dir}: ${(error as Error).message}`,
          target: dir,
        };
      }
    },
  };
}

const HTTP_UNAVAILABLE =
  'ELS has not published its reporting interface yet: the HTTP reporter sends nothing';

/**
 * The HTTP reporter placeholder: refuses every delivery until ELS publishes
 * its interface (records stay pending and the sweep retries them once a
 * real reporter is deployed). Licensed mode refuses ELS_REPORTING_MODE=http.
 */
export function createHttpElsReporter(options: { url?: string | undefined }): ElsReporter {
  const unavailable = async (): Promise<never> => {
    throw new ElsReportingUnavailableError(HTTP_UNAVAILABLE);
  };
  return {
    mode: 'http',
    writeRecord: unavailable,
    writeDailySummary: unavailable,
    async status() {
      return { mode: 'http', ready: false, detail: HTTP_UNAVAILABLE, target: options.url ?? null };
    },
  };
}

/** Reporting off (demo only): nothing is recorded or written. */
export function createOffElsReporter(): ElsReporter {
  const off = async (): Promise<never> => {
    throw new ElsReportingUnavailableError('ELS reporting is off (ELS_REPORTING_MODE=off)');
  };
  return {
    mode: 'off',
    writeRecord: off,
    writeDailySummary: off,
    async status() {
      return { mode: 'off', ready: false, detail: 'ELS reporting is off', target: null };
    },
  };
}

/** The reporter of a configuration (`config.els` of @vamos/config). */
export function createElsReporter(config: {
  reportingMode: ElsReportingMode;
  reportDir: string;
  reportUrl?: string | undefined;
}): ElsReporter {
  switch (config.reportingMode) {
    case 'file':
      return createFileElsReporter({ dir: config.reportDir });
    case 'http':
      return createHttpElsReporter({ url: config.reportUrl });
    case 'off':
      return createOffElsReporter();
  }
}

/** SHA-256 (hex) of a stream line. */
export function elsLineHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

/**
 * - written: this call wrote the record (or found it already in the stream
 *   after an unconfirmed write) and marked it written;
 * - already_written: it was written before (a replay): nothing happened;
 * - not_reportable: the outbox type is not part of the stream;
 * - not_found: no outbox row with this id;
 * - unavailable: the reporter cannot deliver now (HTTP placeholder): the
 *   record stays pending for the sweep;
 * - disabled: reporting is off: nothing was recorded.
 */
export type EmitElsOutcome =
  'written' | 'already_written' | 'not_reportable' | 'not_found' | 'unavailable' | 'disabled';

export interface EmitElsResult {
  outcome: EmitElsOutcome;
  report: ElsReport | null;
}

const WRITER_LOCK = 'vamos:els:writer';
const MAX_ERROR_LENGTH = 1000;

/**
 * Stores the ELS record of an outbox event (pending) unless it is stored
 * already, and returns it (null when the type is not reported or the row
 * does not exist).
 */
export async function recordElsEvent(
  exec: DbExecutor,
  outboxId: bigint,
): Promise<{ report: ElsReport | null; found: boolean }> {
  const [existing] = await exec.select().from(elsReports).where(eq(elsReports.outboxId, outboxId));
  if (existing !== undefined) return { report: existing, found: true };
  const [row] = await exec.select().from(outboxEvents).where(eq(outboxEvents.id, outboxId));
  if (row === undefined) return { report: null, found: false };
  const record = buildElsRecord({
    outboxId: row.id,
    type: row.type,
    occurredAt: row.createdAt,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
  });
  if (record === null) return { report: null, found: true };
  const line = elsRecordLine(record);
  await exec
    .insert(elsReports)
    .values({
      outboxId: row.id,
      type: row.type,
      businessDate: record.businessDate,
      playerRef: record.playerRef,
      line,
      hash: elsLineHash(line),
    })
    .onConflictDoNothing({ target: elsReports.outboxId });
  const [stored] = await exec.select().from(elsReports).where(eq(elsReports.outboxId, outboxId));
  return { report: stored ?? null, found: true };
}

/**
 * Writes the ELS record of one outbox event exactly once (the `els` queue
 * consumer and the sweep call it). Safe to call any number of times, from
 * any number of workers. Errors other than ElsReportingUnavailableError
 * (a full disk…) are recorded on the report and rethrown, so the job is
 * retried; the record stays pending meanwhile.
 */
export async function emitElsEvent(
  db: Database,
  reporter: ElsReporter,
  input: { outboxId: bigint | string },
): Promise<EmitElsResult> {
  if (reporter.mode === 'off') return { outcome: 'disabled', report: null };
  const outboxId = BigInt(input.outboxId);
  // 1. Record it, and count the attempt before anything is written (committed on its own,
  //    so a retry after a crash mid-write knows to look in the stream first).
  const started = await db.transaction(async (tx) => {
    const { report, found } = await recordElsEvent(tx, outboxId);
    if (report === null)
      return { outcome: found ? 'not_reportable' : 'not_found', report } as const;
    if (report.status === 'written') return { outcome: 'already_written', report } as const;
    const [counted] = await tx
      .update(elsReports)
      .set({ attempts: sql`${elsReports.attempts} + 1` })
      .where(and(eq(elsReports.outboxId, outboxId), eq(elsReports.status, 'pending')))
      .returning();
    return counted === undefined
      ? ({ outcome: 'already_written', report } as const)
      : ({ outcome: 'pending', report: counted } as const);
  });
  if (started.outcome !== 'pending') return started;

  // 2. Write it under the writer lock and mark it written.
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${WRITER_LOCK}))`);
      const [report] = await tx
        .select()
        .from(elsReports)
        .where(eq(elsReports.outboxId, outboxId))
        .for('update');
      if (report === undefined) throw new Error(`ELS report ${outboxId} vanished`);
      if (report.status === 'written') return { outcome: 'already_written', report };
      const written = await reporter.writeRecord(
        {
          outboxId: report.outboxId.toString(),
          businessDate: report.businessDate,
          line: report.line,
        },
        { recheck: report.attempts > 1 },
      );
      if (report.type === DAILY_SUMMARY_FINALIZED) {
        const [summary] = await tx
          .select()
          .from(dailySummaries)
          .where(eq(dailySummaries.businessDate, businessDateOfSummaryRecord(report)));
        if (summary?.status === 'final')
          await reporter.writeDailySummary(dailySummaryRowOf(summary));
      }
      const [updated] = await tx
        .update(elsReports)
        .set({
          status: 'written',
          writtenAt: sql`now()`,
          location: written.location,
          lastError: null,
        })
        .where(eq(elsReports.outboxId, outboxId))
        .returning();
      return { outcome: 'written', report: updated ?? report };
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_ERROR_LENGTH,
    );
    await db
      .update(elsReports)
      .set({ lastError: message })
      .where(and(eq(elsReports.outboxId, outboxId), eq(elsReports.status, 'pending')))
      .catch(() => undefined);
    if (error instanceof ElsReportingUnavailableError) {
      const [report] = await db.select().from(elsReports).where(eq(elsReports.outboxId, outboxId));
      return { outcome: 'unavailable', report: report ?? started.report };
    }
    throw error;
  }
}

/** The business date a daily summary record is about (its data, not the day it was finalised). */
function businessDateOfSummaryRecord(report: ElsReport): string {
  const parsed = JSON.parse(report.line) as { data?: { businessDate?: unknown } };
  const date = parsed.data?.businessDate;
  if (typeof date !== 'string' || !isBusinessDate(date)) {
    throw new Error(`ELS report ${report.outboxId} has no business date`);
  }
  return date;
}

/** compliance_cursors name of the last outbox id the sweep checked for unrecorded events. */
export const ELS_OUTBOX_CURSOR = 'els_outbox';

export interface ElsSweepResult {
  /** Reportable outbox events found without a record (a lost job) and recorded now. */
  recorded: number;
  /** Records written by this sweep. */
  written: number;
  /** Records still pending (the reporter is unavailable, or a write failed). */
  pending: number;
  failed: number;
}

/**
 * The sweep's cursor only moves past outbox ids at least this old. Ids come
 * from a sequence at insert while created_at is the transaction's start, so
 * a lower id can commit later (and look younger) than a higher one; a
 * transaction is assumed to stay open less than this.
 */
export const ELS_SWEEP_CURSOR_LAG_MS = 10 * 60_000;

/**
 * The ELS safety net (worker, every few minutes): records the reportable
 * outbox events older than `graceMs` that no job recorded (scanning outbox
 * ids after the cursor, `scanLimit` per run) and writes every pending
 * record older than `graceMs` (`limit` per run). Ages use the database
 * clock, like outbox_events.created_at. The cursor moves only over the run
 * of scanned ids older than `cursorLagMs` (default ELS_SWEEP_CURSOR_LAG_MS,
 * at least `graceMs`): a younger id, or one still in flight, is scanned
 * again by the next sweep instead of being skipped for good.
 */
export async function sweepElsReports(
  db: Database,
  reporter: ElsReporter,
  options: { graceMs?: number; limit?: number; scanLimit?: number; cursorLagMs?: number } = {},
): Promise<ElsSweepResult> {
  const result: ElsSweepResult = { recorded: 0, written: 0, pending: 0, failed: 0 };
  if (reporter.mode === 'off') return result;
  const graceSeconds = Math.max(0, options.graceMs ?? 60_000) / 1000;
  const lagSeconds = Math.max(
    graceSeconds,
    (options.cursorLagMs ?? ELS_SWEEP_CURSOR_LAG_MS) / 1000,
  );
  const limit = options.limit ?? 500;
  const scanLimit = options.scanLimit ?? 5_000;

  // 1. Reportable events that never got a record.
  const [cursor] = await db
    .select({ position: complianceCursors.position })
    .from(complianceCursors)
    .where(eq(complianceCursors.name, ELS_OUTBOX_CURSOR));
  const after = cursor?.position ?? 0n;
  const scanned = await db
    .select({
      id: outboxEvents.id,
      reported: elsReports.outboxId,
      due: sql<boolean>`${outboxEvents.createdAt} < now() - make_interval(secs => ${graceSeconds})`,
      settled: sql<boolean>`${outboxEvents.createdAt} < now() - make_interval(secs => ${lagSeconds})`,
    })
    .from(outboxEvents)
    .leftJoin(elsReports, eq(elsReports.outboxId, outboxEvents.id))
    .where(and(gt(outboxEvents.id, after), inArray(outboxEvents.type, [...ELS_REPORTABLE_TYPES])))
    .orderBy(asc(outboxEvents.id))
    .limit(scanLimit);
  let advanceTo: bigint | null = null;
  let settledRun = true;
  for (const row of scanned) {
    if (settledRun && row.settled) advanceTo = row.id;
    else settledRun = false;
    if (!row.due || row.reported !== null) continue;
    const { report } = await recordElsEvent(db, row.id);
    if (report !== null) result.recorded += 1;
  }
  if (advanceTo !== null) {
    await db
      .insert(complianceCursors)
      .values({ name: ELS_OUTBOX_CURSOR, position: advanceTo })
      .onConflictDoUpdate({
        target: complianceCursors.name,
        set: {
          position: sql`GREATEST(${complianceCursors.position}, ${advanceTo})`,
          updatedAt: sql`now()`,
        },
      });
  }

  // 2. Records not written yet.
  const pending = await db
    .select({ outboxId: elsReports.outboxId })
    .from(elsReports)
    .where(
      and(
        eq(elsReports.status, 'pending'),
        lt(elsReports.createdAt, sql`now() - make_interval(secs => ${graceSeconds})`),
      ),
    )
    .orderBy(asc(elsReports.outboxId))
    .limit(limit);
  for (const { outboxId } of pending) {
    try {
      const emitted = await emitElsEvent(db, reporter, { outboxId });
      if (emitted.outcome === 'written') result.written += 1;
      else if (emitted.outcome === 'unavailable') result.pending += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export interface ElsReportStatus {
  reporter: ElsReporterStatus | null;
  written: number;
  pending: number;
  lastWrittenAt: Date | null;
  oldestPendingAt: Date | null;
  /** The last error of a pending record, if any. */
  lastError: string | null;
  /** Records per business date (newest first, last `days` dates with records). */
  byDate: Array<{ businessDate: string; written: number; pending: number }>;
}

/** The back office's view of the ELS stream (reports.view). */
export async function getElsReportStatus(
  exec: DbExecutor,
  options: { reporter?: ElsReporter; days?: number } = {},
): Promise<ElsReportStatus> {
  const days = Math.min(Math.max(Math.trunc(options.days ?? 14), 1), 92);
  const [totals] = await exec
    .select({
      written: sql<number>`count(*) FILTER (WHERE ${elsReports.status} = 'written')::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${elsReports.status} = 'pending')::int`,
      lastWrittenAt: max(elsReports.writtenAt),
      oldestPendingAt:
        sql<Date | null>`min(${elsReports.createdAt}) FILTER (WHERE ${elsReports.status} = 'pending')`.mapWith(
          (value: string | Date | null) => (value === null ? null : new Date(value)),
        ),
    })
    .from(elsReports);
  const [failing] = await exec
    .select({ lastError: elsReports.lastError })
    .from(elsReports)
    .where(and(eq(elsReports.status, 'pending'), sql`${elsReports.lastError} IS NOT NULL`))
    .orderBy(sql`${elsReports.outboxId} DESC`)
    .limit(1);
  const recentDates = await exec
    .selectDistinct({ businessDate: elsReports.businessDate })
    .from(elsReports)
    .orderBy(sql`${elsReports.businessDate} DESC`)
    .limit(days);
  const dates = recentDates.map((row) => row.businessDate);
  const perDate =
    dates.length === 0
      ? []
      : await exec
          .select({
            businessDate: elsReports.businessDate,
            status: elsReports.status,
            n: count(),
          })
          .from(elsReports)
          .where(inArray(elsReports.businessDate, dates))
          .groupBy(elsReports.businessDate, elsReports.status);
  const byDate = dates.map((businessDate) => ({
    businessDate,
    written:
      perDate.find((row) => row.businessDate === businessDate && row.status === 'written')?.n ?? 0,
    pending:
      perDate.find((row) => row.businessDate === businessDate && row.status === 'pending')?.n ?? 0,
  }));
  return {
    reporter: options.reporter ? await options.reporter.status() : null,
    written: totals?.written ?? 0,
    pending: totals?.pending ?? 0,
    lastWrittenAt: totals?.lastWrittenAt ?? null,
    oldestPendingAt: totals?.oldestPendingAt ?? null,
    lastError: failing?.lastError ?? null,
    byDate,
  };
}

/** The first and last outbox ids recorded (for the status page and tests). */
export async function elsReportRange(
  exec: DbExecutor,
): Promise<{ first: bigint | null; last: bigint | null }> {
  const [row] = await exec
    .select({ first: min(elsReports.outboxId), last: max(elsReports.outboxId) })
    .from(elsReports);
  return { first: row?.first ?? null, last: row?.last ?? null };
}

import { createHash } from 'node:crypto';
import {
  businessDateOf,
  businessDatesBetween,
  businessDayWindow,
  isBusinessDate,
  matchPspStatement,
  parsePspStatementCsv,
  type PspRecord,
  type PspStatementLine,
} from '@vamos/core';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../client';
import { domainBadRequest, domainConflict, domainNotFound, domainUnprocessable } from '../errors';
import type { DbExecutor } from '../ledger/types';
import { writeAudit } from '../platform/audit';
import { paymentIntents, payouts } from '../schema/payments';
import { pspStatementLines, pspStatements, reconciliationRuns } from '../schema/compliance';
import {
  recordReconciliationRun,
  type CheckSummary,
  type MismatchInput,
  type ReconciliationRunDetail,
} from './reconciliation';

/**
 * PSP statements (reconciliation.run): staff upload the provider's own
 * statement as CSV (columns provider, reference, amount, date and an
 * optional type; see @vamos/core pspstatement) and every line is matched
 * against our records. A line must match exactly one deposit intent or
 * payout of its provider by reference (our providerRef), succeeded or paid,
 * for the same amount; every intent succeeded and payout paid in the
 * statement period (by our completion time, Addis Ababa dates) must appear
 * on exactly one line. The statement, its lines and the result are stored
 * (append-only) with a reconciliation run of kind `psp_statement` whose
 * mismatches list each difference; differences raise the usual alert.
 */

export type PspStatement = typeof pspStatements.$inferSelect;
export type PspStatementLineRow = typeof pspStatementLines.$inferSelect;

/** Longest period a statement may cover. */
export const PSP_STATEMENT_MAX_DAYS = 92;
/** Size limit of an uploaded statement (characters). */
export const PSP_STATEMENT_MAX_LENGTH = 5_000_000;
const PROVIDER_RE = /^[a-z0-9_-]{2,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImportPspStatementInput {
  csv: string;
  fileName?: string | null;
  /** When given, every line must be of this provider. */
  provider?: string | null;
  /** The statement period (business dates, inclusive); defaults to the lines' first and last dates. */
  periodFrom?: string | null;
  periodTo?: string | null;
  actor: { adminId: string; ip?: string | null };
  now: Date;
}

export interface ImportPspStatementResult extends ReconciliationRunDetail {
  statement: PspStatement;
  lines: PspStatementLineRow[];
}

function invalidStatement(message: string, details?: unknown) {
  return domainUnprocessable('invalid_statement', message, details);
}

/** Our records of the providers that the lines name, or that completed within the period. */
async function loadRecords(
  exec: DbExecutor,
  providers: string[],
  references: string[],
  period: { from: string; to: string },
): Promise<PspRecord[]> {
  const from = businessDayWindow(period.from).start;
  const to = businessDayWindow(period.to).end;
  const refs = references.length > 0 ? references : ['\u0000'];
  const intents = await exec
    .select({
      id: paymentIntents.id,
      provider: paymentIntents.provider,
      reference: paymentIntents.providerRef,
      amount: paymentIntents.amount,
      status: paymentIntents.status,
      completedAt: paymentIntents.completedAt,
    })
    .from(paymentIntents)
    .where(
      and(
        inArray(paymentIntents.provider, providers),
        or(
          inArray(paymentIntents.providerRef, refs),
          and(
            eq(paymentIntents.status, 'succeeded'),
            sql`${paymentIntents.completedAt} >= ${from.toISOString()}::timestamptz`,
            sql`${paymentIntents.completedAt} < ${to.toISOString()}::timestamptz`,
          ),
        ),
      ),
    );
  const paid = await exec
    .select({
      id: payouts.id,
      provider: payouts.provider,
      reference: payouts.providerRef,
      amount: payouts.amount,
      status: payouts.status,
      completedAt: payouts.completedAt,
    })
    .from(payouts)
    .where(
      and(
        inArray(payouts.provider, providers),
        or(
          inArray(payouts.providerRef, refs),
          and(
            eq(payouts.status, 'paid'),
            sql`${payouts.completedAt} >= ${from.toISOString()}::timestamptz`,
            sql`${payouts.completedAt} < ${to.toISOString()}::timestamptz`,
          ),
        ),
      ),
    );
  const dateOf = (at: Date | null) => (at === null ? null : businessDateOf(at));
  return [
    ...intents.map((row): PspRecord => ({
      kind: 'deposit',
      id: row.id,
      provider: row.provider,
      reference: row.reference,
      amount: row.amount,
      settled: row.status === 'succeeded',
      status: row.status,
      date: row.status === 'succeeded' ? dateOf(row.completedAt) : null,
    })),
    ...paid.map((row): PspRecord => ({
      kind: 'payout',
      id: row.id,
      provider: row.provider,
      reference: row.reference,
      amount: row.amount,
      settled: row.status === 'paid',
      status: row.status,
      date: row.status === 'paid' ? dateOf(row.completedAt) : null,
    })),
  ];
}

/**
 * Imports and matches a statement (see the module comment). 422
 * `invalid_statement` (details { errors: [{ lineNo, message }] }) for a file
 * that does not parse, lines of another provider than `provider`, or a bad
 * period; 409 `statement_already_imported` (details { statementId }) for a
 * file imported before. Audited as `psp_statement.imported`.
 */
export async function importPspStatement(
  db: Database,
  input: ImportPspStatementInput,
): Promise<ImportPspStatementResult> {
  if (typeof input.csv !== 'string' || input.csv.length === 0) {
    throw invalidStatement('The statement file is empty.');
  }
  if (input.csv.length > PSP_STATEMENT_MAX_LENGTH) {
    throw invalidStatement('The statement file is too large.');
  }
  const parsed = parsePspStatementCsv(input.csv);
  if (parsed.errors.length > 0) {
    throw invalidStatement('The statement has lines that cannot be read.', {
      errors: parsed.errors.slice(0, 50),
    });
  }
  const lines = parsed.lines;
  const provider = input.provider?.trim().toLowerCase() || null;
  if (provider !== null) {
    if (!PROVIDER_RE.test(provider)) throw invalidStatement('Unknown provider name.');
    const other = lines.filter((line) => line.provider !== provider);
    if (other.length > 0) {
      throw invalidStatement(`Every line must be of ${provider}.`, {
        errors: other.slice(0, 50).map((line) => ({
          lineNo: line.lineNo,
          message: `provider ${line.provider}`,
        })),
      });
    }
  }
  const dates = lines.map((line) => line.date).sort();
  const periodFrom = input.periodFrom ?? dates[0]!;
  const periodTo = input.periodTo ?? dates[dates.length - 1]!;
  if (!isBusinessDate(periodFrom) || !isBusinessDate(periodTo) || periodFrom > periodTo) {
    throw invalidStatement('The statement period must run from an earlier to a later date.');
  }
  if (businessDatesBetween(periodFrom, periodTo, 100_000).length > PSP_STATEMENT_MAX_DAYS) {
    throw invalidStatement(`A statement may cover at most ${PSP_STATEMENT_MAX_DAYS} days.`);
  }
  const fileHash = createHash('sha256').update(input.csv, 'utf8').digest('hex');
  const providers = [
    ...new Set([...(provider ? [provider] : []), ...lines.map((l) => l.provider)]),
  ].sort();

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`vamos:psp_statement:${fileHash}`}))`,
    );
    const [existing] = await tx
      .select({ id: pspStatements.id })
      .from(pspStatements)
      .where(eq(pspStatements.fileHash, fileHash));
    if (existing !== undefined) {
      throw domainConflict('statement_already_imported', 'This statement was imported already.', {
        statementId: existing.id,
      });
    }
    const records = await loadRecords(
      tx,
      providers,
      [...new Set(lines.map((line) => line.reference))],
      { from: periodFrom, to: periodTo },
    );
    const match = matchPspStatement({ lines, records, period: { from: periodFrom, to: periodTo } });
    let totalIn = 0n;
    let totalOut = 0n;
    for (const line of lines) {
      if (line.amount > 0n) totalIn += line.amount;
      else totalOut -= line.amount;
    }
    const [statement] = await tx
      .insert(pspStatements)
      .values({
        providers,
        periodFrom,
        periodTo,
        fileName: input.fileName?.slice(0, 200) ?? null,
        fileHash,
        lineCount: lines.length,
        totalIn,
        totalOut,
        uploadedBy: input.actor.adminId,
        uploadedAt: input.now,
      })
      .returning();
    if (statement === undefined) throw new Error('statement insert returned no row');
    const byLine = new Map(match.lines.map((result) => [result.lineNo, result]));
    const lineRows = lines.map((line: PspStatementLine) => {
      const result = byLine.get(line.lineNo);
      return {
        statementId: statement.id,
        lineNo: line.lineNo,
        provider: line.provider,
        reference: line.reference,
        amount: line.amount,
        businessDate: line.date,
        kind: line.kind,
        matchStatus: result?.status ?? 'unmatched',
        recordKind: result?.recordKind ?? null,
        recordId: result?.recordId ?? null,
        recordAmount: result?.recordAmount ?? null,
      };
    });
    const storedLines: PspStatementLineRow[] = [];
    for (let i = 0; i < lineRows.length; i += 1000) {
      storedLines.push(
        ...(await tx
          .insert(pspStatementLines)
          .values(lineRows.slice(i, i + 1000))
          .returning()),
      );
    }
    const mismatches: MismatchInput[] = [];
    for (const row of lineRows) {
      if (row.matchStatus === 'matched') continue;
      mismatches.push({
        check: 'psp_statement',
        subjectType: 'psp_statement_line',
        subjectId: `${statement.id}:${row.lineNo}`,
        expected: row.recordAmount === null ? null : row.recordAmount.toString(),
        actual: row.amount.toString(),
        details: {
          status: row.matchStatus,
          lineNo: row.lineNo,
          provider: row.provider,
          reference: row.reference,
          recordKind: row.recordKind,
          recordId: row.recordId,
        },
      });
    }
    for (const record of match.missing) {
      mismatches.push({
        check: 'psp_statement',
        subjectType: record.kind === 'deposit' ? 'payment_intent' : 'payout',
        subjectId: record.id,
        expected: record.amount.toString(),
        actual: null,
        details: {
          status: 'missing_from_statement',
          provider: record.provider,
          reference: record.reference,
          businessDate: record.date,
        },
      });
    }
    const checks: CheckSummary[] = [
      {
        check: 'psp_statement',
        ok: mismatches.length === 0,
        checked: lines.length + records.filter((record) => record.settled).length,
        mismatches: mismatches.length,
      },
    ];
    const run = await recordReconciliationRun(tx, {
      kind: 'psp_statement',
      businessDate: null,
      statementId: statement.id,
      triggeredBy: input.actor.adminId,
      checks,
      mismatches,
      startedAt: input.now,
      finishedAt: input.now,
      ip: input.actor.ip ?? null,
    });
    await writeAudit(tx, {
      actorType: 'admin',
      actorId: input.actor.adminId,
      action: 'psp_statement.imported',
      targetType: 'psp_statement',
      targetId: statement.id,
      metadata: {
        providers,
        periodFrom,
        periodTo,
        fileName: statement.fileName,
        lineCount: lines.length,
        mismatchCount: mismatches.length,
        runId: run.run.id,
      },
      ip: input.actor.ip ?? null,
    });
    return {
      statement,
      lines: storedLines.sort((a, b) => a.lineNo - b.lineNo),
      ...run,
    };
  });
}

/** Statements newest first (cursor: the id of the last statement of the previous page). */
export async function listPspStatements(
  exec: DbExecutor,
  query: { provider?: string; limit?: number; cursor?: string } = {},
): Promise<{
  items: Array<
    PspStatement & { runId: string | null; status: string | null; mismatchCount: number | null }
  >;
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
  const conditions: SQL[] = [];
  if (query.provider !== undefined) {
    conditions.push(sql`${query.provider} = ANY(${pspStatements.providers})`);
  }
  if (query.cursor !== undefined) {
    const [after] = UUID_RE.test(query.cursor)
      ? await exec
          .select({ uploadedAt: pspStatements.uploadedAt, id: pspStatements.id })
          .from(pspStatements)
          .where(eq(pspStatements.id, query.cursor))
      : [];
    if (after === undefined)
      throw domainBadRequest('invalid_cursor', 'This page cursor is not valid.');
    conditions.push(
      sql`(${pspStatements.uploadedAt}, ${pspStatements.id}) < (${after.uploadedAt.toISOString()}::timestamptz, ${after.id}::uuid)`,
    );
  }
  const rows = await exec
    .select({
      statement: pspStatements,
      runId: reconciliationRuns.id,
      status: reconciliationRuns.status,
      mismatchCount: reconciliationRuns.mismatchCount,
    })
    .from(pspStatements)
    .leftJoin(reconciliationRuns, eq(reconciliationRuns.statementId, pspStatements.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(pspStatements.uploadedAt), desc(pspStatements.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit).map((row) => ({
    ...row.statement,
    runId: row.runId,
    status: row.status,
    mismatchCount: row.mismatchCount,
  }));
  return { items, nextCursor: rows.length > limit ? (items[items.length - 1]?.id ?? null) : null };
}

/** One statement with its lines and its matching run. */
export async function getPspStatement(
  exec: DbExecutor,
  statementId: string,
): Promise<{ statement: PspStatement; lines: PspStatementLineRow[]; runId: string | null }> {
  const [statement] = UUID_RE.test(statementId)
    ? await exec.select().from(pspStatements).where(eq(pspStatements.id, statementId))
    : [];
  if (statement === undefined) throw domainNotFound('PSP statement');
  const lines = await exec
    .select()
    .from(pspStatementLines)
    .where(eq(pspStatementLines.statementId, statement.id))
    .orderBy(asc(pspStatementLines.lineNo));
  const [run] = await exec
    .select({ id: reconciliationRuns.id })
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.statementId, statement.id));
  return { statement, lines, runId: run?.id ?? null };
}

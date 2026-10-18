import { businessDateOf, isBusinessDate } from './businessday';
import { parseBirr, type Santim } from './money';

/**
 * Payment-provider (PSP) statements: the provider's own list of what it
 * collected and paid out, imported as CSV and matched line by line against
 * our deposit intents and payouts (pure part).
 *
 * CSV format: a header line naming the columns (any order, case-insensitive)
 * `provider`, `reference`, `amount`, `date` and optionally `type`, then one
 * line per transaction:
 * - provider: the provider name as configured (e.g. `chapa`);
 * - reference: the provider's transaction reference (our providerRef);
 * - amount: birr with at most two decimals ("1250.50"; a thousands comma
 *   needs quotes). A negative amount is money paid out;
 * - date: `YYYY-MM-DD`, or an ISO-8601 time with an offset (read as the
 *   Addis Ababa business date);
 * - type (optional): `deposit` or `payout`.
 */

export type PspRecordKind = 'deposit' | 'payout';

export interface PspStatementLine {
  /** 1-based line number in the file (the header is line 1). */
  lineNo: number;
  provider: string;
  reference: string;
  /** Santim; negative for money paid out. */
  amount: Santim;
  /** Business date `YYYY-MM-DD`. */
  date: string;
  kind: PspRecordKind | null;
}

export interface PspStatementError {
  lineNo: number;
  message: string;
}

export const PSP_STATEMENT_MAX_LINES = 20_000;
const PROVIDER_RE = /^[a-z0-9_-]{2,32}$/;
const MAX_REFERENCE = 200;
const REQUIRED_COLUMNS = ['provider', 'reference', 'amount', 'date'] as const;
const OFFSET_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** At most this many fields per statement row. */
export const PSP_STATEMENT_MAX_FIELDS = 32;

/** A CSV over a row or field limit (`lineNo`: the first line over it). */
export class CsvLimitError extends RangeError {
  constructor(
    message: string,
    readonly lineNo: number,
    readonly limit: 'rows' | 'fields',
  ) {
    super(message);
    this.name = 'CsvLimitError';
  }
}

/**
 * Splits CSV text into rows of fields (RFC 4180: quotes, doubled quotes, CRLF
 * or LF). Every physical row counts toward `maxRows`, blank ones included,
 * and parsing stops at the first row over it or over `maxFields` fields
 * (CsvLimitError), so the work and memory stay bounded by the limits.
 */
export function parseCsvRows(
  text: string,
  options: { maxRows?: number; maxFields?: number } = {},
): string[][] {
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const maxFields = options.maxFields ?? Number.POSITIVE_INFINITY;
  const rows: string[][] = [];
  const pushField = (value: string) => {
    if (row.length >= maxFields) {
      throw new CsvLimitError(`more than ${maxFields} fields on a line`, rows.length + 1, 'fields');
    }
    row.push(value);
  };
  const pushRow = () => {
    if (rows.length >= maxRows) {
      throw new CsvLimitError(`more than ${maxRows} lines`, rows.length + 1, 'rows');
    }
    rows.push(row);
  };
  let row: string[] = [];
  let field = '';
  let quoted = false;
  /** The current field opened with a quote (so `""` at the very end is still a field). */
  let wasQuoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0 && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') {
      pushField(field);
      field = '';
      wasQuoted = false;
    } else if (ch === '\n' || ch === '\r') {
      pushField(field);
      pushRow();
      row = [];
      field = '';
      wasQuoted = false;
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (quoted) throw new SyntaxError('unterminated quoted field');
  if (wasQuoted || field.length > 0 || row.length > 0) {
    pushField(field);
    pushRow();
  }
  return rows;
}

function parseDate(text: string): string | null {
  if (isBusinessDate(text)) return text;
  if (OFFSET_TIME_RE.test(text)) {
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return businessDateOf(new Date(ms));
  }
  return null;
}

/**
 * Parses a statement. Every bad line is reported (with its line number); a
 * statement with any error should be refused as a whole.
 */
export function parsePspStatementCsv(
  text: string,
  options: { maxLines?: number } = {},
): { lines: PspStatementLine[]; errors: PspStatementError[] } {
  const maxLines = options.maxLines ?? PSP_STATEMENT_MAX_LINES;
  let rows: string[][];
  try {
    // The header, maxLines lines (blank ones count) and nothing more.
    rows = parseCsvRows(text, { maxRows: maxLines + 1, maxFields: PSP_STATEMENT_MAX_FIELDS });
  } catch (error) {
    if (error instanceof CsvLimitError) {
      const message = error.limit === 'rows' ? `more than ${maxLines} lines` : error.message;
      return { lines: [], errors: [{ lineNo: error.lineNo, message }] };
    }
    return { lines: [], errors: [{ lineNo: 0, message: (error as Error).message }] };
  }
  const header = rows[0];
  if (header === undefined) return { lines: [], errors: [{ lineNo: 1, message: 'empty file' }] };
  const columns = header.map((name) => name.trim().toLowerCase());
  const index = new Map<string, number>();
  columns.forEach((name, i) => {
    if (!index.has(name)) index.set(name, i);
  });
  const missing = REQUIRED_COLUMNS.filter((name) => !index.has(name));
  if (missing.length > 0) {
    return {
      lines: [],
      errors: [{ lineNo: 1, message: `missing column(s): ${missing.join(', ')}` }],
    };
  }
  const typeIndex = index.get('type');
  const lines: PspStatementLine[] = [];
  const errors: PspStatementError[] = [];
  for (let r = 1; r < rows.length; r += 1) {
    const lineNo = r + 1;
    const row = rows[r]!;
    if (row.every((cell) => cell.trim().length === 0)) continue;
    if (lines.length + errors.length >= maxLines) {
      errors.push({ lineNo, message: `more than ${maxLines} lines` });
      break;
    }
    const cell = (name: string) => (row[index.get(name)!] ?? '').trim();
    const provider = cell('provider').toLowerCase();
    const reference = cell('reference');
    const problems: string[] = [];
    if (!PROVIDER_RE.test(provider)) problems.push('invalid provider');
    if (reference.length === 0 || reference.length > MAX_REFERENCE) {
      problems.push('invalid reference');
    }
    let amount = 0n;
    try {
      amount = parseBirr(cell('amount'), { allowNegative: true });
      if (amount === 0n) problems.push('amount must not be zero');
    } catch {
      problems.push('invalid amount');
    }
    const date = parseDate(cell('date'));
    if (date === null) problems.push('invalid date');
    let kind: PspRecordKind | null = null;
    if (typeIndex !== undefined) {
      const type = (row[typeIndex] ?? '').trim().toLowerCase();
      if (type === 'deposit' || type === 'payout') kind = type;
      else if (type.length > 0) problems.push('type must be deposit or payout');
    }
    if (kind === 'deposit' && amount < 0n) problems.push('a deposit amount must be positive');
    if (problems.length > 0 || date === null) {
      errors.push({ lineNo, message: problems.join('; ') });
      continue;
    }
    lines.push({ lineNo, provider, reference, amount, date, kind });
  }
  if (lines.length === 0 && errors.length === 0) {
    errors.push({ lineNo: 2, message: 'the statement has no lines' });
  }
  return { lines, errors };
}

/** One of our deposit intents or payouts, as the statement matching sees it. */
export interface PspRecord {
  kind: PspRecordKind;
  id: string;
  provider: string;
  reference: string | null;
  /** Santim (positive). */
  amount: Santim;
  /** Succeeded deposit / paid payout: money moved at the provider. */
  settled: boolean;
  status: string;
  /** Business date of completion (null when not completed). */
  date: string | null;
}

/**
 * - matched: one settled record with this reference, the same amount and
 *   direction (a deposit is money in, a payout money out);
 * - direction_mismatch: one record, but the line moves money the other way
 *   (a payout returned to the operator, money out on a deposit);
 * - amount_mismatch: one settled record, another amount;
 * - status_mismatch: one record that is not settled (the provider moved
 *   money we do not count as moved: a failed or expired deposit, a payout
 *   whose hold went back);
 * - unmatched: no record with this reference;
 * - ambiguous: several records could be meant;
 * - duplicate: an earlier line already has this reference, or already
 *   matched the same record.
 */
export type PspLineStatus =
  | 'matched'
  | 'amount_mismatch'
  | 'direction_mismatch'
  | 'status_mismatch'
  | 'unmatched'
  | 'ambiguous'
  | 'duplicate';

export interface PspLineMatch {
  lineNo: number;
  status: PspLineStatus;
  recordKind: PspRecordKind | null;
  recordId: string | null;
  recordAmount: Santim | null;
  recordStatus: string | null;
}

export interface PspStatementMatch {
  lines: PspLineMatch[];
  /** Settled records completed within the period that no line matched (sorted by date, id). */
  missing: PspRecord[];
}

const abs = (amount: Santim) => (amount < 0n ? -amount : amount);

/**
 * Matches statement lines to records: each line should match exactly one
 * record and every settled record completed in the period exactly one line.
 */
export function matchPspStatement(input: {
  lines: readonly PspStatementLine[];
  records: readonly PspRecord[];
  period: { from: string; to: string };
}): PspStatementMatch {
  const byReference = new Map<string, PspRecord[]>();
  for (const record of input.records) {
    if (record.reference === null) continue;
    const key = `${record.provider}\u0000${record.reference}`;
    const list = byReference.get(key);
    if (list) list.push(record);
    else byReference.set(key, [record]);
  }
  const seenLines = new Set<string>();
  const seenRecords = new Set<string>();
  const results: PspLineMatch[] = [];
  const lines = [...input.lines].sort((a, b) => a.lineNo - b.lineNo);
  for (const line of lines) {
    const filter: PspRecordKind | null = line.kind ?? (line.amount < 0n ? 'payout' : null);
    const lineKey = `${line.provider}\u0000${line.reference}\u0000${filter ?? '*'}`;
    const none = { recordKind: null, recordId: null, recordAmount: null, recordStatus: null };
    if (seenLines.has(lineKey)) {
      results.push({ lineNo: line.lineNo, status: 'duplicate', ...none });
      continue;
    }
    seenLines.add(lineKey);
    const candidates = (byReference.get(`${line.provider}\u0000${line.reference}`) ?? []).filter(
      (record) => filter === null || record.kind === filter,
    );
    if (candidates.length !== 1) {
      results.push({
        lineNo: line.lineNo,
        status: candidates.length === 0 ? 'unmatched' : 'ambiguous',
        ...none,
      });
      continue;
    }
    const record = candidates[0]!;
    const recordKey = `${record.kind}:${record.id}`;
    if (seenRecords.has(recordKey)) {
      results.push({ lineNo: line.lineNo, status: 'duplicate', ...none });
      continue;
    }
    seenRecords.add(recordKey);
    const rightWay = record.kind === 'deposit' ? line.amount > 0n : line.amount < 0n;
    const status: PspLineStatus = !rightWay
      ? 'direction_mismatch'
      : !record.settled
        ? 'status_mismatch'
        : abs(line.amount) === record.amount
          ? 'matched'
          : 'amount_mismatch';
    results.push({
      lineNo: line.lineNo,
      status,
      recordKind: record.kind,
      recordId: record.id,
      recordAmount: record.amount,
      recordStatus: record.status,
    });
  }
  const { from, to } = input.period;
  const missing = input.records
    .filter(
      (record) =>
        record.settled &&
        record.date !== null &&
        record.date >= from &&
        record.date <= to &&
        !seenRecords.has(`${record.kind}:${record.id}`),
    )
    .sort((a, b) =>
      a.date === b.date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.date! < b.date! ? -1 : 1,
    );
  return { lines: results, missing };
}

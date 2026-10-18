import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { domainBadRequest } from '../errors';

/** The staff member behind a back-office change (audit actor; `ip` for the audit log). */
export interface StaffActor {
  adminId: string;
  ip?: string | null;
}

/** One page of a back-office list; `nextCursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** A page size within 1..max (default `fallback`). */
export function pageLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) return fallback;
  return Math.min(limit, max);
}

/**
 * Position in a list sorted by a timestamp then a uuid. The time is the
 * column's own text to the microsecond (cursorTime): a JavaScript Date
 * keeps milliseconds only, and a row whose time has microseconds would be
 * shown again on the next page.
 */
export interface TimeCursor {
  /** UTC, `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  at: string;
  id: string;
}

const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The microsecond-precise UTC text of a timestamptz column or expression (select it for the cursor). */
export function cursorTime(column: SQLWrapper): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** Rows after the cursor in a list ordered by (column, id) ascending or descending. */
export function afterCursor(
  column: SQLWrapper,
  idColumn: SQLWrapper,
  cursor: TimeCursor,
  direction: 'asc' | 'desc',
): SQL {
  return direction === 'asc'
    ? sql`(${column}, ${idColumn}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
    : sql`(${column}, ${idColumn}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

/** Opaque cursor text (base64url JSON) of a (time, id) position. */
export function encodeCursor(cursor: TimeCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.at, i: cursor.id }), 'utf8').toString('base64url');
}

/** 400 `invalid_cursor` for anything encodeCursor did not produce. */
export function decodeCursor(text: string): TimeCursor {
  const invalid = () => domainBadRequest('invalid_cursor', 'This page cursor is not valid.');
  if (typeof text !== 'string' || text.length === 0 || text.length > 200) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { t, i } = parsed as { t?: unknown; i?: unknown };
  if (typeof t !== 'string' || !CURSOR_TIME_RE.test(t) || Number.isNaN(Date.parse(t))) {
    throw invalid();
  }
  if (typeof i !== 'string' || !UUID_RE.test(i)) throw invalid();
  return { at: t, id: i };
}

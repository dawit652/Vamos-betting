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

/** Position of a list sorted by a timestamp then an id. */
export interface TimeCursor {
  at: Date;
  id: string;
}

const CURSOR_ID_RE = /^[0-9A-Za-z-]{1,64}$/;

/** Opaque cursor text (base64url JSON) of a (time, id) position. */
export function encodeCursor(cursor: TimeCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.at.toISOString(), i: cursor.id }), 'utf8').toString(
    'base64url',
  );
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
  if (typeof t !== 'string' || typeof i !== 'string' || !CURSOR_ID_RE.test(i)) throw invalid();
  const at = new Date(t);
  if (Number.isNaN(at.getTime())) throw invalid();
  return { at, id: i };
}

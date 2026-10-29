/**
 * Rule T1 (docs/scraper.md section 6.4): a source's local wall-clock time
 * plus an explicit IANA zone becomes a UTC instant, or is rejected.
 *
 * A wall time can map to zero instants (the hour skipped when clocks go
 * forward) or two (the hour repeated when they go back). Picking one would
 * put a kickoff an hour off, so both are refused: the record is dropped with
 * an issue and a person fixes the source. Only the platform's `Intl` and its
 * tz database are used (no dependency).
 */

export type ZonedFailure =
  'invalid_date' | 'invalid_time' | 'unknown_zone' | 'dst_gap' | 'dst_ambiguous';

export type ZonedResult = { ok: true; instant: Date } | { ok: false; reason: ZonedFailure };

export interface ZonedInput {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:MM' or 'HH:MM:SS' (24-hour clock; 24:00 is invalid). */
  time: string;
  /** IANA zone name, e.g. 'Africa/Addis_Ababa'. */
  timeZone: string;
}

/** Earliest and latest year accepted: outside, tz data is unreliable (LMT) and a typo is likelier. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether the runtime knows this IANA zone. Never throws. */
export function isValidTimeZone(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false;
  // Newer engines also accept bare offsets ('+03:00'); T1 asks for a named IANA zone.
  if (/^[+-]/.test(name)) return false;
  try {
    formatterFor(name);
    return true;
  } catch {
    return false;
  }
}

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallPartsAt(instantMs: number, timeZone: string): WallParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') values[part.type] = Number.parseInt(part.value, 10);
  }
  return {
    year: values.year ?? Number.NaN,
    month: values.month ?? Number.NaN,
    day: values.day ?? Number.NaN,
    // Some engines print midnight as 24 even with h23.
    hour: (values.hour ?? Number.NaN) % 24,
    minute: values.minute ?? Number.NaN,
    second: values.second ?? Number.NaN,
  };
}

/** A wall time read as if it were UTC (the year-safe way: Date.UTC maps 0..99 to 19xx). */
function wallAsUtcMs(p: WallParts): number {
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(p.hour, p.minute, p.second, 0);
  return d.getTime();
}

/** UTC offset (ms, local minus UTC) in force at an instant. `instantMs` is whole seconds. */
function offsetAt(instantMs: number, timeZone: string): number {
  return wallAsUtcMs(wallPartsAt(instantMs, timeZone)) - instantMs;
}

function parseDate(date: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return null;
  // Round trip through a real calendar: Feb 30 would roll over to Mar 2.
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function parseTime(time: string): { hour: number; minute: number; second: number } | null {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] === undefined ? 0 : Number(m[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

/**
 * Rule T1. The instants a wall time can denote are `wall - offset` for each
 * offset that is actually in force at that instant. The offsets to try are
 * those seen around the wall time (+/- 24 h every 2 h covers every real
 * transition, including 30- and 45-minute ones): zero self-consistent
 * candidates is a gap, two is an overlap, never a guess.
 */
export function zonedToUtc(input: ZonedInput): ZonedResult {
  if (typeof input?.date !== 'string' || typeof input.time !== 'string') {
    return { ok: false, reason: typeof input?.date === 'string' ? 'invalid_time' : 'invalid_date' };
  }
  const date = parseDate(input.date);
  if (!date) return { ok: false, reason: 'invalid_date' };
  const time = parseTime(input.time);
  if (!time) return { ok: false, reason: 'invalid_time' };
  if (!isValidTimeZone(input.timeZone)) return { ok: false, reason: 'unknown_zone' };
  const timeZone = input.timeZone;

  const wallMs = wallAsUtcMs({ ...date, ...time });
  const offsets = new Set<number>();
  for (let step = -12; step <= 12; step += 1) {
    offsets.add(offsetAt(wallMs + step * 2 * 3_600_000, timeZone));
  }
  const instants = new Set<number>();
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (offsetAt(candidate, timeZone) === offset) instants.add(candidate);
  }
  if (instants.size === 0) return { ok: false, reason: 'dst_gap' };
  if (instants.size > 1) return { ok: false, reason: 'dst_ambiguous' };
  const [instant] = [...instants];
  return { ok: true, instant: new Date(instant as number) };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * The calendar date ('YYYY-MM-DD') an instant falls on in a zone.
 * Throws RangeError for an invalid date or unknown zone (a programming error,
 * not a data error: callers hold validated instants and configured zones).
 */
export function localDateOf(instant: Date, timeZone: string): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new RangeError('localDateOf: invalid date');
  }
  if (!isValidTimeZone(timeZone))
    throw new RangeError(`localDateOf: unknown time zone ${timeZone}`);
  const p = wallPartsAt(Math.floor(instant.getTime() / 1000) * 1000, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
}

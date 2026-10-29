/**
 * TEMPORARY local stand-in for `zonedToUtc` / `isValidTimeZone` from
 * '../normalize', which another engineer is writing. It has the same
 * signature; once '../normalize' exports them, `common.ts` switches its import
 * and this file is deleted.
 *
 * Why it is strict: a local time that does not exist (DST gap) or happens twice
 * (DST overlap) must be rejected, never guessed (rule T1).
 */

export type ZonedResult = { ok: true; instant: Date } | { ok: false; reason: string };

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock of `utcMs` in the zone, as if it were UTC milliseconds. */
function wallClockMs(utcMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

export function zonedToUtc(input: { date: string; time: string; timeZone: string }): ZonedResult {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input.time);
  if (!d || !t) return { ok: false, reason: 'malformed date or time' };
  if (!isValidTimeZone(input.timeZone)) return { ok: false, reason: 'unknown time zone' };
  const [y, mo, da, h, mi, s] = [d[1], d[2], d[3], t[1], t[2], t[3] ?? '0'].map(Number) as [
    number, number, number, number, number, number,
  ];
  const wall = Date.UTC(y, mo - 1, da, h, mi, s);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== da ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    return { ok: false, reason: 'not a calendar date or time' };
  }
  // Candidate instants: the wall clock minus each offset seen around the date.
  const offsets = new Set<number>();
  for (const shift of [-36, 0, 36]) {
    const probe = wall + shift * 3_600_000;
    offsets.add(wallClockMs(probe, input.timeZone) - probe);
  }
  const matches = new Set<number>();
  for (const off of offsets) {
    const candidate = wall - off;
    if (wallClockMs(candidate, input.timeZone) === wall) matches.add(candidate);
  }
  if (matches.size === 0) return { ok: false, reason: 'local time does not exist (DST gap)' };
  if (matches.size > 1) return { ok: false, reason: 'local time is ambiguous (DST overlap)' };
  return { ok: true, instant: new Date([...matches][0] as number) };
}

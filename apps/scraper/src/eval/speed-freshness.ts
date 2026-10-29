/**
 * P1 of docs/scraper-evaluation/02-speed-and-resilience.md: how fresh is the public source?
 *
 * Reads the git history of openfootball `football.json` league files (and, optionally, the
 * `fixtures.csv` history of vaastav/Fantasy-Premier-League) and measures, per match, how long after
 * the final whistle (kickoff + 105 min) the full-time score first appears in a commit, how often a
 * published score or kickoff was later changed, and which fixtures vanished.
 *
 * Read-only: runs `git log` / `git show` in the given clone and writes one JSON file.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/speed-freshness.ts <openfootballClone> <out.json> [fplClone]
 *
 * Nothing here touches the network or a database.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { zonedToUtc } from '@vamos/scraper';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FINAL_WHISTLE_MS = 105 * MIN;
/** "Now" of the evaluation (the day the live file was compared with the clone's head). */
const NOW = new Date('2026-10-29T20:30:00Z');

interface LeagueFile {
  id: string;
  path: string;
  timeZone: string;
}
const FILES: LeagueFile[] = [
  { id: 'en.1 2026-27', path: '2026-27/en.1.json', timeZone: 'Europe/London' },
  { id: 'en.1 2025-26', path: '2025-26/en.1.json', timeZone: 'Europe/London' },
  { id: 'es.1 2026-27', path: '2026-27/es.1.json', timeZone: 'Europe/Madrid' },
  { id: 'de.1 2026-27', path: '2026-27/de.1.json', timeZone: 'Europe/Berlin' },
  { id: 'it.1 2026-27', path: '2026-27/it.1.json', timeZone: 'Europe/Rome' },
  { id: 'fr.1 2026-27', path: '2026-27/fr.1.json', timeZone: 'Europe/Paris' },
  { id: 'es.1 2025-26', path: '2025-26/es.1.json', timeZone: 'Europe/Madrid' },
];

// --- small statistics ---------------------------------------------------------------------------

export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export interface Summary {
  n: number;
  minH: number | null;
  medianH: number | null;
  p90H: number | null;
  maxH: number | null;
}
const hours = (ms: number | null): number | null => (ms === null ? null : round(ms / HOUR, 1));
function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
export function summarise(valuesMs: readonly number[]): Summary {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  return {
    n: sorted.length,
    minH: hours(sorted[0] ?? null),
    medianH: hours(quantile(sorted, 0.5)),
    p90H: hours(quantile(sorted, 0.9)),
    maxH: hours(sorted[sorted.length - 1] ?? null),
  };
}

const BUCKETS: Array<[string, number]> = [
  ['<6 h', 6 * HOUR],
  ['6-24 h', DAY],
  ['1-3 d', 3 * DAY],
  ['3-7 d', 7 * DAY],
  ['7-14 d', 14 * DAY],
  ['>=14 d', Infinity],
];
function bucketCounts(valuesMs: readonly number[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(BUCKETS.map(([name]) => [name, 0]));
  for (const v of valuesMs) {
    const bucket = BUCKETS.find(([, limit]) => v < limit);
    if (bucket !== undefined) out[bucket[0]] = (out[bucket[0]] ?? 0) + 1;
  }
  return out;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --- git ----------------------------------------------------------------------------------------

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

interface Commit {
  sha: string;
  time: Date;
}
function history(repo: string, path: string): Commit[] {
  const out = git(repo, ['log', '--reverse', '--format=%H%x09%cI', '--', path]);
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = '', iso = ''] = line.split('\t');
      return { sha, time: new Date(iso) };
    });
}

// --- openfootball snapshots ---------------------------------------------------------------------

interface Rec {
  key: string;
  date: string | null;
  time: string | null;
  kickoffMs: number | null;
  status: string | null;
  /** none: no score key; empty: `{}`; list: bare `[a, b]`; ft: object with `ft`; other */
  scoreShape: 'none' | 'empty' | 'list' | 'ft' | 'other';
  ft: [number, number] | null;
  ht: [number, number] | null;
}
interface Snapshot {
  commit: Commit;
  valid: boolean;
  invalidReason: string | null;
  recs: Map<string, Rec>;
  records: number;
  duplicateKeys: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
function pair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v as unknown[];
  return typeof a === 'number' && typeof b === 'number' ? [a, b] : null;
}

function parseSnapshot(commit: Commit, text: string, timeZone: string): Snapshot {
  const base = { commit, recs: new Map<string, Rec>(), records: 0, duplicateKeys: 0 };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return {
      ...base,
      valid: false,
      invalidReason: `invalid JSON (${error instanceof Error ? error.message : 'parse error'})`,
    };
  }
  const matches = isObj(json) ? json.matches : undefined;
  if (!Array.isArray(matches)) {
    return { ...base, valid: false, invalidReason: 'no matches array' };
  }
  let withDate = 0;
  for (const m of matches as unknown[]) {
    if (!isObj(m)) continue;
    base.records += 1;
    const date = typeof m.date === 'string' ? m.date : null;
    const time = typeof m.time === 'string' ? m.time : null;
    if (date !== null) withDate += 1;
    let kickoffMs: number | null = null;
    if (date !== null && time !== null && /^\d{1,2}:\d{2}$/.test(time)) {
      const z = zonedToUtc({ date, time: time.padStart(5, '0'), timeZone });
      if (z.ok) kickoffMs = z.instant.getTime();
    }
    const s = m.score;
    let scoreShape: Rec['scoreShape'] = 'none';
    let ft: [number, number] | null = null;
    let ht: [number, number] | null = null;
    if (s !== undefined && s !== null) {
      if (Array.isArray(s)) scoreShape = 'list';
      else if (isObj(s)) {
        ft = pair(s.ft);
        ht = pair(s.ht);
        scoreShape = ft !== null ? 'ft' : Object.keys(s).length === 0 ? 'empty' : 'other';
      } else scoreShape = 'other';
    }
    const key = `${String(m.team1)}|${String(m.team2)}`;
    if (base.recs.has(key)) {
      base.duplicateKeys += 1;
      continue;
    }
    base.recs.set(key, {
      key,
      date,
      time,
      kickoffMs,
      status: typeof m.status === 'string' ? m.status : null,
      scoreShape,
      ft,
      ht,
    });
  }
  if (base.records === 0 || withDate / base.records < 0.9) {
    return {
      ...base,
      valid: false,
      invalidReason: `${base.records - withDate} of ${base.records} records have no date`,
    };
  }
  return { ...base, valid: true, invalidReason: null };
}

const ftKey = (ft: [number, number] | null): string => (ft === null ? '-' : `${ft[0]}-${ft[1]}`);

interface MatchTrack {
  key: string;
  firstSeenIdx: number;
  /** first valid snapshot (index into valid list) in which a scraper-readable full time was present */
  firstFtIdx: number | null;
  /** first one with any score including the bare `[0, 0]` list the adapter refuses */
  firstAnyScoreIdx: number | null;
  corrections: Array<{ at: Date; afterMs: number; from: string; to: string; goalsDiff: number }>;
  scoreRemoved: number;
  reschedules: Array<{
    at: Date;
    fromKickoff: string;
    toKickoff: string;
    shiftH: number | null;
    daysBeforeOld: number | null;
    daysBeforeNew: number | null;
  }>;
  timeAdded: Array<{ at: Date; daysBeforeKickoff: number | null }>;
  disappearedAt: Date | null;
  reappeared: boolean;
  statuses: string[];
}

function analyseLeague(repo: string, file: LeagueFile) {
  const commits = history(repo, file.path);
  const snaps: Snapshot[] = commits.map((c) =>
    parseSnapshot(c, git(repo, ['show', `${c.sha}:${file.path}`]), file.timeZone),
  );
  const valid = snaps.filter((s) => s.valid);
  const tracks = new Map<string, MatchTrack>();
  const track = (key: string, idx: number): MatchTrack => {
    let t = tracks.get(key);
    if (t === undefined) {
      t = {
        key,
        firstSeenIdx: idx,
        firstFtIdx: null,
        firstAnyScoreIdx: null,
        corrections: [],
        scoreRemoved: 0,
        reschedules: [],
        timeAdded: [],
        disappearedAt: null,
        reappeared: false,
        statuses: [],
      };
      tracks.set(key, t);
    }
    return t;
  };
  let added = 0;
  valid.forEach((snap, idx) => {
    const prev = idx > 0 ? valid[idx - 1] : undefined;
    for (const rec of snap.recs.values()) {
      const t = track(rec.key, idx);
      if (prev !== undefined && !prev.recs.has(rec.key)) {
        if (t.disappearedAt !== null) t.reappeared = true;
        else if (t.firstSeenIdx === idx) added += 1;
      }
      if (t.firstFtIdx === null && rec.ft !== null) t.firstFtIdx = idx;
      if (t.firstAnyScoreIdx === null && (rec.ft !== null || rec.scoreShape === 'list')) {
        t.firstAnyScoreIdx = idx;
      }
      if (rec.status !== null && !t.statuses.includes(rec.status)) t.statuses.push(rec.status);
      const before = prev?.recs.get(rec.key);
      if (before === undefined) continue;
      const at = snap.commit.time;
      // corrections: both snapshots carry a full time and it differs
      if (before.ft !== null && rec.ft !== null && ftKey(before.ft) !== ftKey(rec.ft)) {
        const first = valid[t.firstFtIdx ?? idx]?.commit.time ?? at;
        t.corrections.push({
          at,
          afterMs: at.getTime() - first.getTime(),
          from: ftKey(before.ft),
          to: ftKey(rec.ft),
          goalsDiff: Math.abs(before.ft[0] - rec.ft[0]) + Math.abs(before.ft[1] - rec.ft[1]),
        });
      } else if (before.ft !== null && rec.ft === null && rec.scoreShape !== 'list')
        t.scoreRemoved += 1;
      // reschedules and time publication
      const dateChanged = before.date !== null && rec.date !== null && before.date !== rec.date;
      const timeChanged = before.time !== null && rec.time !== null && before.time !== rec.time;
      if (dateChanged || timeChanged) {
        const oldMs =
          before.kickoffMs ?? (before.date ? Date.parse(`${before.date}T12:00:00Z`) : null);
        const newMs = rec.kickoffMs ?? (rec.date ? Date.parse(`${rec.date}T12:00:00Z`) : null);
        t.reschedules.push({
          at,
          fromKickoff: `${before.date ?? '?'} ${before.time ?? '--:--'}`,
          toKickoff: `${rec.date ?? '?'} ${rec.time ?? '--:--'}`,
          shiftH:
            before.kickoffMs !== null && rec.kickoffMs !== null
              ? round((rec.kickoffMs - before.kickoffMs) / HOUR, 1)
              : null,
          daysBeforeOld: oldMs === null ? null : round((oldMs - at.getTime()) / DAY, 1),
          daysBeforeNew: newMs === null ? null : round((newMs - at.getTime()) / DAY, 1),
        });
      } else if (before.time === null && rec.time !== null && rec.kickoffMs !== null) {
        t.timeAdded.push({
          at,
          daysBeforeKickoff: round((rec.kickoffMs - at.getTime()) / DAY, 1),
        });
      }
    }
    if (prev !== undefined) {
      for (const key of prev.recs.keys()) {
        if (!snap.recs.has(key)) {
          const t = track(key, idx);
          if (t.disappearedAt === null) t.disappearedAt = snap.commit.time;
        }
      }
    }
  });
  const first = valid[0];
  const last = valid[valid.length - 1];
  if (first === undefined || last === undefined) {
    return { id: file.id, error: 'no valid snapshot' };
  }

  // Final kickoff of every match = the latest snapshot's (or the last one that had it).
  const finalRec = (key: string): Rec | undefined => {
    for (let i = valid.length - 1; i >= 0; i -= 1) {
      const rec = valid[i]?.recs.get(key);
      if (rec !== undefined) return rec;
    }
    return undefined;
  };
  const lagsTimed: number[] = [];
  const lagsTimedAny: number[] = [];
  /** Observed lags plus, for matches still without a score at NOW, the wait so far (a lower bound). */
  const lagsWithPending: number[] = [];
  const lagsDateOnlyLowerBound: number[] = [];
  const lagByKickoffWeekday: Record<string, number[]> = {};
  const censoredAtFirstSnapshot: number[] = [];
  for (const t of tracks.values()) {
    const rec = finalRec(t.key);
    if (rec === undefined || t.firstFtIdx === null) continue;
    const snap = valid[t.firstFtIdx];
    if (snap === undefined) continue;
    if (t.firstFtIdx === 0 && valid.length > 1 && t.firstSeenIdx === 0) {
      const anyBefore = first.recs.get(t.key)?.ft ?? null;
      if (anyBefore !== null) {
        censoredAtFirstSnapshot.push(1);
        continue;
      }
    }
    if (rec.kickoffMs !== null) {
      const lag = snap.commit.time.getTime() - (rec.kickoffMs + FINAL_WHISTLE_MS);
      lagsTimed.push(lag);
      const wd = WEEKDAYS[new Date(rec.kickoffMs).getUTCDay()] ?? '?';
      (lagByKickoffWeekday[wd] ??= []).push(lag);
    } else if (rec.date !== null) {
      // no kickoff time: measure from the END of the calendar day (UTC): a lower bound on the lag
      lagsDateOnlyLowerBound.push(
        snap.commit.time.getTime() - (Date.parse(`${rec.date}T00:00:00Z`) + DAY),
      );
    }
  }
  for (const t of tracks.values()) {
    const rec = finalRec(t.key);
    if (rec === undefined || t.firstAnyScoreIdx === null || rec.kickoffMs === null) continue;
    const snap = valid[t.firstAnyScoreIdx];
    if (snap !== undefined && !(t.firstAnyScoreIdx === 0 && t.firstSeenIdx === 0)) {
      lagsTimedAny.push(snap.commit.time.getTime() - (rec.kickoffMs + FINAL_WHISTLE_MS));
    }
  }

  for (const rec of last.recs.values()) {
    if (rec.kickoffMs === null || rec.ft !== null) continue;
    const waitedMs = NOW.getTime() - (rec.kickoffMs + FINAL_WHISTLE_MS);
    if (waitedMs > 0) lagsWithPending.push(waitedMs);
  }
  lagsWithPending.push(...lagsTimed);
  // played but no score, as of the latest commit and as of NOW (the live file equals the head).
  const played = (rec: Rec, at: Date): boolean =>
    rec.kickoffMs !== null
      ? rec.kickoffMs + FINAL_WHISTLE_MS < at.getTime()
      : rec.date !== null && Date.parse(`${rec.date}T00:00:00Z`) + DAY < at.getTime();
  const unscored = (at: Date) => {
    let playedN = 0;
    let none = 0;
    let bareList = 0;
    let noTime = 0;
    let postponed = 0;
    for (const rec of last.recs.values()) {
      if (!played(rec, at)) continue;
      playedN += 1;
      if (rec.status === 'postponed') postponed += 1;
      if (rec.ft === null) {
        if (rec.scoreShape === 'list') bareList += 1;
        else none += 1;
      }
      if (rec.time === null) noTime += 1;
    }
    return { played: playedN, noScore: none, bareListScore: bareList, noTime, postponed };
  };

  const commitGaps = valid.slice(1).map((s, i) => {
    const before = valid[i];
    return before === undefined ? 0 : s.commit.time.getTime() - before.commit.time.getTime();
  });
  const commitWeekday: Record<string, number> = {};
  const commitHour: Record<string, number> = {};
  for (const s of valid) {
    const d = s.commit.time;
    const wd = WEEKDAYS[d.getUTCDay()] ?? '?';
    commitWeekday[wd] = (commitWeekday[wd] ?? 0) + 1;
    const h = String(d.getUTCHours()).padStart(2, '0');
    commitHour[h] = (commitHour[h] ?? 0) + 1;
  }

  const all = [...tracks.values()];
  const corrections = all.flatMap((t) => t.corrections.map((c) => ({ key: t.key, ...c })));
  const reschedules = all.flatMap((t) => t.reschedules.map((r) => ({ key: t.key, ...r })));
  const timeAdded = all.flatMap((t) => t.timeAdded);
  const lead = (xs: Array<number | null>) =>
    xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  const resLead = lead(reschedules.map((r) => r.daysBeforeOld));
  const taLead = lead(timeAdded.map((t) => t.daysBeforeKickoff));
  const noTimeAtLast = [...last.recs.values()].filter((r) => r.time === null).length;
  const window = { retroactive: 0, within14d: 0, beyond14d: 0, unknown: 0 };
  const within = { earlier: 0, laterUpTo2h: 0, laterOver2h: 0, timeWasMissing: 0 };
  for (const r of reschedules) {
    if (r.daysBeforeOld === null) window.unknown += 1;
    else if (r.daysBeforeOld < 0) window.retroactive += 1;
    else if (r.daysBeforeOld <= 14) {
      window.within14d += 1;
      if (r.shiftH === null) within.timeWasMissing += 1;
      else if (r.shiftH < 0) within.earlier += 1;
      else if (r.shiftH <= 2) within.laterUpTo2h += 1;
      else within.laterOver2h += 1;
    } else window.beyond14d += 1;
  }
  const bareZeroZeroKickoffs = [...last.recs.values()]
    .filter((r) => r.scoreShape === 'list' && r.kickoffMs !== null)
    .map((r) => r.kickoffMs ?? 0);
  return {
    id: file.id,
    path: file.path,
    commitsTotal: commits.length,
    commitsValid: valid.length,
    invalidSnapshots: snaps
      .filter((s) => !s.valid)
      .map((s) => ({
        sha: s.commit.sha.slice(0, 9),
        at: s.commit.time.toISOString(),
        reason: s.invalidReason,
      })),
    firstCommit: { sha: first.commit.sha.slice(0, 9), at: first.commit.time.toISOString() },
    lastCommit: { sha: last.commit.sha.slice(0, 9), at: last.commit.time.toISOString() },
    matchesAtLast: last.recs.size,
    duplicateKeysAnywhere: snaps.reduce((a, s) => a + s.duplicateKeys, 0),
    updateGapsH: summarise(commitGaps),
    commitsByWeekdayUtc: commitWeekday,
    commitsByHourUtc: commitHour,
    bareZeroZeroKickoffs,
    scoredAtLast: [...last.recs.values()].filter((r) => r.ft !== null).length,
    bareListScoresAtLast: [...last.recs.values()].filter((r) => r.scoreShape === 'list').length,
    emptyScoreObjectsAtLast: [...last.recs.values()].filter((r) => r.scoreShape === 'empty').length,
    noTimeAtLast,
    freshness: {
      withTime: {
        ...summarise(lagsTimed),
        buckets: bucketCounts(lagsTimed),
        byKickoffWeekday: Object.fromEntries(
          WEEKDAYS.map((d) => [d, summarise(lagByKickoffWeekday[d] ?? [])]),
        ),
      },
      withTimeIncludingBareZeroZero: summarise(lagsTimedAny),
      withTimeIncludingStillPendingAsLowerBound: summarise(lagsWithPending),
      dateOnlyLowerBound: {
        ...summarise(lagsDateOnlyLowerBound),
        buckets: bucketCounts(lagsDateOnlyLowerBound),
      },
      alreadyScoredInFirstSnapshotExcluded: censoredAtFirstSnapshot.length,
    },
    unscored: {
      atLastCommit: unscored(last.commit.time),
      atNow: unscored(NOW),
    },
    corrections: {
      count: corrections.length,
      matches: new Set(corrections.map((c) => c.key)).size,
      list: corrections.slice(0, 40).map((c) => ({
        key: c.key,
        from: c.from,
        to: c.to,
        goalsDiff: c.goalsDiff,
        afterH: hours(c.afterMs),
        at: c.at.toISOString(),
      })),
      scoreRemoved: all.reduce((a, t) => a + t.scoreRemoved, 0),
    },
    reschedules: {
      count: reschedules.length,
      matches: new Set(reschedules.map((r) => r.key)).size,
      byWhenItAppeared: window,
      within14dBreakdown: within,
      daysBeforeOldKickoff: {
        n: resLead.length,
        median: round(quantile(resLead, 0.5) ?? NaN, 1),
        min: resLead[0] ?? null,
        max: resLead[resLead.length - 1] ?? null,
      },
      list: reschedules.slice(0, 60).map((r) => ({
        key: r.key,
        from: r.fromKickoff,
        to: r.toKickoff,
        shiftH: r.shiftH,
        daysBeforeOld: r.daysBeforeOld,
        at: r.at.toISOString(),
      })),
    },
    timePublished: {
      count: timeAdded.length,
      daysBeforeKickoff: {
        n: taLead.length,
        median: round(quantile(taLead, 0.5) ?? NaN, 1),
        p10: round(quantile(taLead, 0.1) ?? NaN, 1),
        min: taLead[0] ?? null,
        max: taLead[taLead.length - 1] ?? null,
      },
    },
    disappeared: all.filter((t) => t.disappearedAt !== null && !t.reappeared).length,
    disappearedAndReappeared: all.filter((t) => t.reappeared).length,
    addedAfterFirstSnapshot: added,
    postponedStatusMatches: all
      .filter((t) => t.statuses.length > 0)
      .map((t) => ({
        key: t.key,
        statuses: t.statuses,
      })),
  };
}

// --- FPL fixtures.csv ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || (row[0] ?? '') !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface FplFix {
  finished: boolean;
  kickoff: string | null;
  hs: string;
  as: string;
}
function fplSnapshot(text: string): Map<string, FplFix> {
  const [header = [], ...rows] = parseCsv(text);
  const col = (name: string) => header.indexOf(name);
  const iId = col('id');
  const iFin = col('finished');
  const iKo = col('kickoff_time');
  const iH = col('team_h_score');
  const iA = col('team_a_score');
  const out = new Map<string, FplFix>();
  for (const r of rows) {
    out.set(r[iId] ?? '', {
      finished: r[iFin] === 'True',
      kickoff: (r[iKo] ?? '') === '' ? null : (r[iKo] ?? null),
      hs: r[iH] ?? '',
      as: r[iA] ?? '',
    });
  }
  return out;
}

function analyseFpl(repo: string, season: string) {
  const path = `data/${season}/fixtures.csv`;
  const commits = history(repo, path);
  const snaps = commits.map((c) => ({
    c,
    fx: fplSnapshot(git(repo, ['show', `${c.sha}:${path}`])),
  }));
  const first = new Map<string, { at: Date; idx: number }>();
  const lastKickoff = new Map<string, string | null>();
  let scoreChanges = 0;
  let kickoffChanges = 0;
  const kickoffChangeList: Array<{
    id: string;
    from: string | null;
    to: string | null;
    at: string;
  }> = [];
  snaps.forEach((snap, idx) => {
    for (const [id, f] of snap.fx) {
      lastKickoff.set(id, f.kickoff);
      if (f.finished && !first.has(id)) first.set(id, { at: snap.c.time, idx });
      const before = snaps[idx - 1]?.fx.get(id);
      if (before !== undefined) {
        if (
          before.finished &&
          f.finished &&
          (Number(before.hs) !== Number(f.hs) || Number(before.as) !== Number(f.as))
        )
          scoreChanges += 1;
        if (before.kickoff !== f.kickoff) {
          kickoffChanges += 1;
          kickoffChangeList.push({
            id,
            from: before.kickoff,
            to: f.kickoff,
            at: snap.c.time.toISOString(),
          });
        }
      }
    }
  });
  const lags: number[] = [];
  let censored = 0;
  for (const [id, f] of first) {
    const ko = lastKickoff.get(id);
    if (ko === null || ko === undefined) continue;
    if (f.idx === 0) {
      censored += 1;
      continue;
    }
    lags.push(f.at.getTime() - (Date.parse(ko) + FINAL_WHISTLE_MS));
  }
  const lastSnap = snaps[snaps.length - 1];
  const lastAt = lastSnap?.c.time ?? NOW;
  let playedNoScore = 0;
  let playedN = 0;
  for (const [id, f] of lastSnap?.fx ?? []) {
    const ko = lastKickoff.get(id);
    if (ko === null || ko === undefined) continue;
    if (Date.parse(ko) + FINAL_WHISTLE_MS < lastAt.getTime()) {
      playedN += 1;
      if (!f.finished) playedNoScore += 1;
    }
  }
  const zeroZero = new Set<number>();
  const finishedKickoffs = new Set<number>();
  for (const f of lastSnap?.fx.values() ?? []) {
    if (!f.finished || f.kickoff === null) continue;
    finishedKickoffs.add(Date.parse(f.kickoff));
    if (Number(f.hs) === 0 && Number(f.as) === 0) zeroZero.add(Date.parse(f.kickoff));
  }
  return {
    zeroZero,
    finishedKickoffs,
    season,
    commits: commits.map((c) => ({ sha: c.sha.slice(0, 9), at: c.time.toISOString() })),
    commitGapsH: summarise(
      snaps.slice(1).map((s, i) => s.c.time.getTime() - (snaps[i]?.c.time.getTime() ?? 0)),
    ),
    fixturesAtLast: lastSnap?.fx.size ?? 0,
    firstFinishedLag: { ...summarise(lags), buckets: bucketCounts(lags) },
    finishedAlreadyInFirstSnapshotExcluded: censored,
    playedAtLastCommit: playedN,
    playedNoScoreAtLastCommit: playedNoScore,
    scoreChanges,
    kickoffChanges,
    kickoffChangeList: kickoffChangeList.slice(0, 40),
  };
}

// --- main ---------------------------------------------------------------------------------------

function main(): void {
  const [repo, out, fplRepo] = process.argv.slice(2);
  if (repo === undefined || out === undefined) {
    process.stderr.write('usage: speed-freshness.ts <openfootballClone> <out.json> [fplClone]\n');
    process.exit(2);
  }
  const result: Record<string, unknown> = {
    generatedBy: 'apps/scraper/src/eval/speed-freshness.ts',
    now: NOW.toISOString(),
    finalWhistleAfterKickoffMin: 105,
    openfootballHead: git(repo, ['log', '-1', '--format=%H %cI']).trim(),
    leagues: FILES.map((f) => analyseLeague(repo, f)),
  };
  if (fplRepo !== undefined) {
    result.fplHead = git(fplRepo, ['log', '-1', '--format=%H %cI']).trim();
    const fpl = ['2025-26', '2026-27'].map((season) => analyseFpl(fplRepo, season));
    const crossCheck = fpl.map((f) => {
      const league = (
        result.leagues as Array<{ id: string; bareZeroZeroKickoffs?: number[] }>
      ).find((l) => l.id === `en.1 ${f.season}`);
      const kickoffs = league?.bareZeroZeroKickoffs ?? [];
      return {
        season: f.season,
        bareZeroZeroInOpenfootball: kickoffs.length,
        fplFinishedAtSameKickoff: kickoffs.filter((k) => f.finishedKickoffs.has(k)).length,
        fplZeroZeroAtSameKickoff: kickoffs.filter((k) => f.zeroZero.has(k)).length,
      };
    });
    result.bareZeroZeroCrossCheck = crossCheck;
    result.fpl = fpl.map(({ zeroZero: _a, finishedKickoffs: _b, ...rest }) => rest);
  }
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`wrote ${out}\n`);
}

main();

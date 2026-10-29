import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zonedToUtc } from '@vamos/scraper';
import {
  argOf,
  buildAdapter,
  countBy,
  loadFpl,
  ofUrl,
  parseDocument,
  pct,
  readEnvelope,
  requiredArg,
  SOURCE_FILE,
  type OfMatch,
} from './data-lib';

/**
 * Measurement 7 of the data-accuracy evaluation: how the openfootball file CHANGED over its git
 * history. Each commit that touched <season>/en.1.json is one snapshot of what the scraper
 * would have read at that time. <dir> holds commits.txt ("<sha> <commit time>" per line,
 * oldest first) and the snapshots as NNN_<sha>.json (made with `git show <sha>:<file>`).
 *
 *   tsx src/eval/data-history.ts --dir <dir> --season 2025-26 [--out <json>]
 *
 * Asked of every snapshot:
 *  - did a score ever change after it first appeared (a correction),
 *  - did a kickoff change (a reschedule, or a placeholder time that was later fixed),
 *  - did any match carry a score BEFORE its kickoff (a not-yet-played match turned into a result),
 *  - for the fixtures in the 14 days after the snapshot, how often did the listed kickoff differ
 *    from the final one (what an event created at that time would have carried).
 */

interface Entry {
  date: string;
  time: string;
  kickoff: Date | null;
  score: string;
}

interface Snap {
  at: Date;
  sha: string;
  byKey: Map<string, Entry>;
  body: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function scoreKey(score: unknown): string {
  if (score === undefined) return '';
  if (Array.isArray(score)) return `bare${JSON.stringify(score)}`;
  const s = score as { ft?: number[]; ht?: number[]; et?: number[]; p?: number[] };
  return `ft${JSON.stringify(s.ft ?? null)} ht${JSON.stringify(s.ht ?? null)}${s.et ? ` et${JSON.stringify(s.et)}` : ''}${s.p ? ` p${JSON.stringify(s.p)}` : ''}`;
}

const ftOf = (k: string): string =>
  k.startsWith('bare') ? k.slice(4) : (/^ft(\[[^\]]*\])/.exec(k)?.[1] ?? '');

const invalidSnapshots: Array<{ sha: string; at: string; error: string }> = [];
const allBodies: Array<{ sha: string; at: string; body: string }> = [];

function load(dir: string, zone: string): Snap[] {
  const commits = readFileSync(join(dir, 'commits.txt'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(' ') as [string, string]);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const snaps: Snap[] = [];
  commits.forEach(([sha, at], i) => {
    const file = files[i];
    if (file === undefined || !file.includes(sha))
      throw new Error(`snapshot ${i} does not match ${sha}`);
    let json: { matches: OfMatch[] };
    const body = readFileSync(join(dir, file), 'utf8');
    allBodies.push({ sha, at, body });
    try {
      json = JSON.parse(body) as { matches: OfMatch[] };
    } catch (error) {
      // The adapter would answer this document with a fatal bad_json issue.
      invalidSnapshots.push({
        sha,
        at,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const byKey = new Map<string, Entry>();
    for (const m of json.matches) {
      const z = zonedToUtc({ date: m.date, time: (m.time ?? '').padStart(5, '0'), timeZone: zone });
      byKey.set(`${m.team1}|${m.team2}`, {
        date: m.date,
        time: m.time ?? '',
        kickoff: z.ok ? z.instant : null,
        score: scoreKey(m.score),
      });
    }
    snaps.push({ at: new Date(at), sha, byKey, body });
  });
  return snaps;
}

const args = process.argv.slice(2);
const dir = requiredArg(args, 'dir');
const season = requiredArg(args, 'season');
const snaps = load(dir, 'Europe/London');
const last = snaps[snaps.length - 1];
if (last === undefined) throw new Error('no snapshots');
const keys = [...last.byKey.keys()];

// The "final" kickoff of a fixture: the last snapshot's, or the FPL one when --fpl-dir is given.
const fplDir = argOf(args, 'fpl-dir');
const truth = new Map<string, Date | null>();
for (const key of keys) truth.set(key, last.byKey.get(key)?.kickoff ?? null);
if (fplDir !== undefined) {
  for (const f of loadFpl(fplDir, season)) truth.set(`${f.home}|${f.away}`, f.kickoff);
}

// What the real adapter makes of every historic document (the yield the runner would have seen).
const envelope = readEnvelope(SOURCE_FILE);
const label = 'English Premier League';
const adapter = buildAdapter(envelope, ofUrl(season, 'en.1'), label, 'Europe/London');
const yields = allBodies.map(({ sha, at, body }) => {
  const outcome = parseDocument(adapter, ofUrl(season, 'en.1'), body, new Date(at));
  const fatal = outcome.issues.find((i) => i.fatal === true);
  return {
    commit: sha.slice(0, 7),
    at: new Date(at).toISOString().slice(0, 10),
    seen: outcome.stats.recordsSeen,
    accepted: outcome.stats.recordsAccepted,
    fixtures: outcome.fixtures.length,
    results: outcome.results.length,
    rejectedRate: pct(
      outcome.stats.recordsSeen - outcome.stats.recordsAccepted,
      outcome.stats.recordsSeen,
    ),
    fatal: fatal ? fatal.code : null,
    issues: countBy(outcome.issues, (i) => `${i.code}`),
  };
});

const scoreChanges: Array<Record<string, unknown>> = [];
const encodingChanges: Array<Record<string, unknown>> = [];
const timeChanges: Array<Record<string, unknown>> = [];
const scoredBeforeKickoff: Array<Record<string, unknown>> = [];
const disappeared: string[] = [];

for (const key of keys) {
  let prev: Entry | undefined;
  let prevAt: Date | undefined;
  for (const s of snaps) {
    const cur = s.byKey.get(key);
    if (cur === undefined) {
      if (prev !== undefined) disappeared.push(`${key}@${s.sha.slice(0, 7)}`);
      continue;
    }
    if (ftOf(cur.score) !== '' && cur.kickoff !== null && s.at.getTime() < cur.kickoff.getTime()) {
      scoredBeforeKickoff.push({
        match: key,
        snapshot: s.at.toISOString(),
        kickoff: cur.kickoff.toISOString(),
        score: cur.score,
      });
    }
    if (prev !== undefined && prevAt !== undefined) {
      if (
        prev.score !== '' &&
        cur.score !== '' &&
        prev.score !== cur.score &&
        ftOf(prev.score) !== ''
      ) {
        const sameFt = ftOf(prev.score) === ftOf(cur.score);
        (sameFt ? encodingChanges : scoreChanges).push({
          match: key,
          from: prev.score,
          to: cur.score,
          between: `${prevAt.toISOString().slice(0, 10)}..${s.at.toISOString().slice(0, 10)}`,
        });
      }
      if (ftOf(prev.score) !== '' && cur.score === '') {
        scoreChanges.push({
          match: key,
          from: prev.score,
          to: '(score removed)',
          between: `${prevAt.toISOString().slice(0, 10)}..${s.at.toISOString().slice(0, 10)}`,
        });
      }
      if (
        prev.time !== '' &&
        cur.time !== '' &&
        (prev.date !== cur.date || prev.time !== cur.time)
      ) {
        timeChanges.push({
          match: key,
          from: `${prev.date} ${prev.time}`,
          to: `${cur.date} ${cur.time}`,
          snapshot: s.at.toISOString().slice(0, 10),
          daysBeforeNewKickoff:
            cur.kickoff === null
              ? null
              : Math.round(((cur.kickoff.getTime() - s.at.getTime()) / DAY) * 10) / 10,
        });
      }
    }
    prev = cur;
    prevAt = s.at;
  }
}

// Scores in each snapshot against the FPL final score (official upstream).
const fplScores = new Map<string, string>();
if (fplDir !== undefined) {
  for (const f of loadFpl(fplDir, season)) {
    if (f.finished) fplScores.set(`${f.home}|${f.away}`, `[${f.homeScore},${f.awayScore}]`);
  }
}
const wrongScores = new Map<
  string,
  { first: string; last: string; shown: string; final: string; date: string }
>();
const scoreAccuracyPerSnapshot = snaps.map((s) => {
  let scored = 0;
  let checked = 0;
  let wrong = 0;
  for (const [key, e] of s.byKey) {
    const ft = ftOf(e.score);
    if (ft === '') continue;
    scored += 1;
    const fin = fplScores.get(key);
    if (fin === undefined) continue;
    checked += 1;
    if (ft !== fin) {
      wrong += 1;
      const prior = wrongScores.get(key);
      wrongScores.set(key, {
        first: prior?.first ?? s.at.toISOString().slice(0, 10),
        last: s.at.toISOString().slice(0, 10),
        shown: ft,
        final: fin,
        date: e.date,
      });
    }
  }
  return {
    snapshot: s.at.toISOString().slice(0, 10),
    scoredMatches: scored,
    comparedToFpl: checked,
    wrongVsFpl: wrong,
  };
});

// What an event created at each snapshot would have carried: fixtures whose FINAL kickoff lies in
// (snapshot + 10 min, snapshot + 14 days], listed kickoff against the final one.
let exposed = 0;
let noTime = 0;
let exposedWrong = 0;
const wrongBySnapshot: Array<Record<string, unknown>> = [];
const wrongSizes: number[] = [];
for (const s of snaps) {
  let n = 0;
  let wrong = 0;
  for (const key of keys) {
    const fin = truth.get(key);
    const cur = s.byKey.get(key);
    if (!fin || !cur) continue;
    const ahead = fin.getTime() - s.at.getTime();
    if (ahead <= 10 * 60_000 || ahead > 14 * DAY) continue;
    if (cur.kickoff === null) {
      noTime += 1;
      continue;
    }
    n += 1;
    if (cur.kickoff.getTime() !== fin.getTime()) {
      wrong += 1;
      wrongSizes.push(Math.abs(cur.kickoff.getTime() - fin.getTime()) / 60_000);
    }
  }
  exposed += n;
  exposedWrong += wrong;
  wrongBySnapshot.push({
    snapshot: s.at.toISOString().slice(0, 16),
    fixturesIn14d: n,
    listedKickoffDiffersFromFinal: wrong,
  });
}

const out = {
  season,
  snapshots: snaps.length + invalidSnapshots.length,
  truthForKickoff: fplDir === undefined ? 'last openfootball snapshot' : 'FPL fixtures.csv',
  adapterYieldPerSnapshot: yields,
  invalidSnapshots,
  firstSnapshot: snaps[0]?.at.toISOString(),
  lastSnapshot: last.at.toISOString(),
  matchesInLastSnapshot: keys.length,
  scoreAccuracyVsFplPerSnapshot: scoreAccuracyPerSnapshot,
  matchesWithAWrongScoreInSomeSnapshot: [...wrongScores].map(([match, w]) => ({ match, ...w })),
  scoreCorrections: scoreChanges,
  encodingOnlyChanges: encodingChanges.slice(0, 5),
  encodingOnlyChangeCount: encodingChanges.length,
  matchesWhoseKickoffChanged: new Set(timeChanges.map((t) => String(t['match']))).size,
  kickoffChangeEvents: timeChanges.length,
  kickoffChangesByLeadDays: countBy(timeChanges, (t) => {
    const d = t['daysBeforeNewKickoff'] as number | null;
    return d === null
      ? 'n/a'
      : d < 0
        ? 'after the new kickoff'
        : d < 1
          ? '<1d'
          : d < 7
            ? '1-7d'
            : d < 14
              ? '7-14d'
              : '>=14d';
  }),
  timeChanges: timeChanges.slice(0, 25),
  scoredBeforeKickoff: scoredBeforeKickoff.slice(0, 10),
  scoredBeforeKickoffCount: scoredBeforeKickoff.length,
  matchesMissingFromLaterSnapshots: disappeared.slice(0, 20),
  exposure14d: {
    fixtureSnapshotsInWindow: exposed,
    fixtureSnapshotsInWindowWithoutTimeDroppedByAdapter: noTime,
    listedKickoffWrong: exposedWrong,
    rate: pct(exposedWrong, exposed),
    medianAbsErrorMin: wrongSizes.sort((a, b) => a - b)[Math.floor(wrongSizes.length / 2)] ?? null,
    perSnapshot: wrongBySnapshot,
  },
};
const outPath = argOf(args, 'out');
if (outPath) writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
const summary = {
  ...out,
  timeChanges: `(${timeChanges.length})`,
  scoreCorrections: scoreChanges.length,
  exposure14d: { ...out.exposure14d, perSnapshot: undefined },
};
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);

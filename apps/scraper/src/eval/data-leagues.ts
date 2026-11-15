import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildAdapter,
  countBy,
  ofUrl,
  parseDocument,
  pct,
  readEnvelope,
  readOfMatches,
  requiredArg,
  argOf,
  SOURCE_FILE,
} from './data-lib';

/**
 * Measurements 2, 3 and 6 on EVERY openfootball league file in <dir>/of/<season>/: what the
 * real adapter makes of the file (yield, reject reasons), how scores are written (bare pairs,
 * half time, extra time / penalties), and how kickoff times are written. The time zone per league
 * is the zone the league plays in (an assumption the evaluation checks with the time-slot table).
 *
 *   tsx src/eval/data-leagues.ts --data <dir> --out <json> [--now <ISO>]
 */

const ZONES: Record<string, string> = {
  'en.1': 'Europe/London',
  'en.2': 'Europe/London',
  'en.3': 'Europe/London',
  'es.1': 'Europe/Madrid',
  'de.1': 'Europe/Berlin',
  'it.1': 'Europe/Rome',
  'fr.1': 'Europe/Paris',
  'pt.1': 'Europe/Lisbon',
  'nl.1': 'Europe/Amsterdam',
  'at.1': 'Europe/Vienna',
  'tr.1': 'Europe/Istanbul',
};

const args = process.argv.slice(2);
const dir = requiredArg(args, 'data');
const out = requiredArg(args, 'out');
const now = new Date(argOf(args, 'now') ?? new Date().toISOString());
const envelope = readEnvelope(SOURCE_FILE);

const rows: Array<Record<string, unknown>> = [];
for (const season of ['2025-26', '2026-27']) {
  const files = readdirSync(join(dir, 'of', season))
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of files) {
    const league = file.replace(/\.json$/, '');
    let of;
    try {
      of = readOfMatches(join(dir, 'of', season, file));
    } catch {
      continue; // a 404 body ("404: Not Found") is not a league file
    }
    const zone = ZONES[league];
    if (zone === undefined) continue;
    const url = ofUrl(season, league);
    const adapter = buildAdapter(envelope, url, of.name || league, zone);
    const outcome = parseDocument(adapter, url, of.body, now);
    const bare = of.matches.filter((m) => Array.isArray(m.score));
    const objs = of.matches.filter(
      (m) => typeof m.score === 'object' && m.score !== null && !Array.isArray(m.score),
    );
    const keysOf = (m: { score?: unknown }) =>
      Object.keys(m.score as object)
        .sort()
        .join('+');
    const dates = of.matches.map((m) => m.date).sort();
    const badDates = of.matches.filter((m) => {
      const t = Date.parse(`${m.date}T00:00:00Z`);
      return (
        !/^\d{4}-\d{2}-\d{2}$/.test(m.date) ||
        Number.isNaN(t) ||
        new Date(t).toISOString().slice(0, 10) !== m.date
      );
    }).length;
    rows.push({
      season,
      league,
      competitionNameInFile: of.name,
      zone,
      records: of.matches.length,
      accepted: outcome.stats.recordsAccepted,
      rejected: outcome.stats.recordsSeen - outcome.stats.recordsAccepted,
      rejectedRate: pct(
        outcome.stats.recordsSeen - outcome.stats.recordsAccepted,
        outcome.stats.recordsSeen,
      ),
      fixtures: outcome.fixtures.length,
      results: outcome.results.length,
      issues: countBy(outcome.issues, (i) => `${i.severity}:${i.code}`),
      rawScoreShapes: countBy(of.matches, (m) =>
        m.score === undefined
          ? 'none'
          : Array.isArray(m.score)
            ? 'bare pair'
            : `object ${keysOf(m)}`,
      ),
      barePairValues: countBy(bare, (m) => JSON.stringify(m.score)),
      objectFtZeroZero: objs.filter(
        (m) => JSON.stringify((m.score as { ft?: unknown }).ft) === '[0,0]',
      ).length,
      withEtOrPenalties: objs.filter(
        (m) => 'et' in (m.score as object) || 'p' in (m.score as object),
      ).length,
      resultsWithHalfTime: outcome.results.filter((r) => typeof r.score?.htHome === 'number')
        .length,
      resultsWithoutHalfTime: outcome.results.filter((r) => typeof r.score?.htHome !== 'number')
        .length,
      scoreBasis: countBy(outcome.results, (r) => r.scoreBasis),
      missingTime: of.matches.filter((m) => m.time === undefined || m.time === null).length,
      midnightTimes: of.matches.filter((m) => m.time === '00:00').length,
      nonHhmmTimes: of.matches.filter(
        (m) => m.time !== undefined && !/^\d{1,2}:\d{2}$/.test(m.time),
      ).length,
      invalidCalendarDates: badDates,
      dateRange: `${dates[0]}..${dates[dates.length - 1]}`,
      localTimeSlots: countBy(
        of.matches.filter((m) => m.time !== undefined),
        (m) => String(m.time),
      ),
      clubs: [...new Set(of.matches.flatMap((m) => [m.team1, m.team2]))].sort(),
    });
  }
}
writeFileSync(
  out,
  `${JSON.stringify({ fetchTimeUsedForParsing: now.toISOString(), leagues: rows }, null, 1)}\n`,
);
process.stdout.write(`${`wrote ${out} (${rows.length} league files)`}\n`);

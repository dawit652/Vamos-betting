import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeName, zonedToUtc } from '@vamos/scraper';
import {
  buildAdapter,
  countBy,
  loadFpl,
  type Fpl,
  minutesBetween,
  ofUrl,
  parseDocument,
  pct,
  readEnvelope,
  readOfMatches,
  requiredArg,
  argOf,
  SOURCE_FILE,
  type OfMatch,
} from './data-lib';

/**
 * Measurements 1, 2, 3 and 6 of the data-accuracy evaluation: the real openfootball adapter on
 * the real Premier League files against the FPL fixtures (an independent upstream).
 *
 *   tsx src/eval/data-fpl.ts --data <dir> --out <json> [--now <ISO>]
 *
 * <dir> holds of/<season>/en.1.json and fpl/<season>/{fixtures,teams}.csv.
 */

const key = (home: string, away: string): string => `${home}|${away}`;
const iso = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');
const DST_AROUND = [
  { name: '2026-03-29 (UK clocks forward)', date: Date.UTC(2026, 2, 29) },
  { name: '2026-10-25 (UK clocks back)', date: Date.UTC(2026, 9, 25) },
];

function season(dir: string, envelopePath: string, seasonName: string, now: Date) {
  const envelope = readEnvelope(envelopePath);
  const url = ofUrl(seasonName, 'en.1');
  const of = readOfMatches(join(dir, 'of', seasonName, 'en.1.json'));
  const adapter = buildAdapter(
    envelope,
    url,
    (envelope.config['requests'] as Array<{ competition: string }>)[0]?.competition ??
      'English Premier League',
    String(envelope.config['timeZone']),
  );
  const outcome = parseDocument(adapter, url, of.body, now);
  const fpl = loadFpl(dir, seasonName);

  // --- what the adapter produced, by (home, away) -----------------------------------------
  const fixtures = new Map(outcome.fixtures.map((f) => [key(f.home, f.away), f]));
  const results = new Map(outcome.results.map((r) => [key(r.home, r.away), r]));
  const rejected = new Map<number, string>();
  const rejectedIssues = outcome.issues.filter((i) => i.severity === 'error');
  for (const i of rejectedIssues) {
    const idx = i.context?.['index'];
    if (typeof idx === 'number') rejected.set(idx, i.code);
  }

  const fplByKey = new Map(fpl.map((f) => [key(f.home, f.away), f]));
  const ofKeys = of.matches.map((m) => key(m.team1, m.team2));
  const duplicateOfKeys = ofKeys.filter((k, i) => ofKeys.indexOf(k) !== i);
  const onlyOf = of.matches.filter((m) => !fplByKey.has(key(m.team1, m.team2)));
  const ofKeySet = new Set(ofKeys);
  const onlyFpl = fpl.filter((f) => !ofKeySet.has(key(f.home, f.away)));

  // --- per raw record -----------------------------------------------------------------------
  interface Row {
    index: number;
    m: OfMatch;
    fpl: Fpl | undefined;
    adapter: 'fixture' | 'result' | 'rejected';
    rejectCode: string | null;
    kickoffRaw: Date | null;
    kickoffAdapter: Date | null;
  }
  const rows: Row[] = of.matches.map((m, index) => {
    const k = key(m.team1, m.team2);
    const f = fixtures.get(k);
    const r = results.get(k);
    const zoned = zonedToUtc({
      date: m.date,
      time: (m.time ?? '').padStart(5, '0'),
      timeZone: String(envelope.config['timeZone']),
    });
    return {
      index,
      m,
      fpl: fplByKey.get(k),
      adapter: f ? 'fixture' : r ? 'result' : 'rejected',
      rejectCode: rejected.get(index) ?? null,
      kickoffRaw: zoned.ok ? zoned.instant : null,
      kickoffAdapter: (f ?? r)?.kickoff ?? null,
    };
  });

  // --- 1. kickoff vs FPL ----------------------------------------------------------------------
  const paired = rows.filter((r) => r.fpl !== undefined && r.kickoffRaw !== null);
  const diffs = paired.map((r) => ({
    r,
    min: minutesBetween(r.kickoffRaw as Date, (r.fpl as Fpl).kickoff),
  }));
  const exact = diffs.filter((d) => d.min === 0);
  const adapterVsRaw = rows.filter(
    (r) =>
      r.kickoffAdapter !== null &&
      r.kickoffRaw !== null &&
      r.kickoffAdapter.getTime() !== r.kickoffRaw.getTime(),
  ).length;
  const mismatches = diffs
    .filter((d) => d.min !== 0)
    .map(({ r, min }) => {
      const f = r.fpl as Fpl;
      const sameLondonDay =
        new Date(f.kickoff).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) === r.m.date;
      return {
        match: `${r.m.team1} v ${r.m.team2}`,
        round: r.m.round,
        ofLocal: `${r.m.date} ${r.m.time}`,
        ours: iso(r.kickoffRaw as Date),
        fpl: iso(f.kickoff),
        diffMin: min,
        sameLocalDate: sameLondonDay,
        finishedInFpl: f.finished,
        adapterStatus: r.adapter === 'rejected' ? `rejected:${r.rejectCode}` : r.adapter,
      };
    });
  const dst = DST_AROUND.map((w) => {
    const near = paired.filter(
      (r) => Math.abs((r.kickoffRaw as Date).getTime() - w.date) <= 3 * 86_400_000,
    );
    return {
      window: w.name,
      matches: near.length,
      exact: near.filter(
        (r) => (r.kickoffRaw as Date).getTime() === (r.fpl as Fpl).kickoff.getTime(),
      ).length,
      beforeChange: near.filter((r) => (r.kickoffRaw as Date).getTime() < w.date + 1 * 3_600_000)
        .length,
    };
  });

  // --- 2. scores vs FPL --------------------------------------------------------------------------
  const finishedFpl = fpl.filter((f) => f.finished);
  const scoreRows = finishedFpl.map((f) => {
    const k = key(f.home, f.away);
    const res = results.get(k);
    const raw = rows.find((r) => key(r.m.team1, r.m.team2) === k);
    return { f, res, raw };
  });
  const scoreBoth = scoreRows.filter((s) => s.res !== undefined);
  const scoreEqual = scoreBoth.filter(
    (s) => s.res?.score?.home === s.f.homeScore && s.res?.score?.away === s.f.awayScore,
  );
  const scoreMismatch = scoreBoth
    .filter((s) => !(s.res?.score?.home === s.f.homeScore && s.res?.score?.away === s.f.awayScore))
    .map((s) => ({
      match: `${s.f.home} v ${s.f.away}`,
      date: s.raw?.m.date,
      ours: `${s.res?.score?.home}-${s.res?.score?.away}`,
      fpl: `${s.f.homeScore}-${s.f.awayScore}`,
    }));
  const finishedNoResult = scoreRows.filter((s) => s.res === undefined);
  const hidden = finishedNoResult.filter((s) => s.raw !== undefined && s.raw.rejectCode !== null);
  const notYetInOf = finishedNoResult.filter(
    (s) => s.raw !== undefined && s.raw.rejectCode === null,
  );
  const hiddenDetail = hidden.map((s) => ({
    match: `${s.f.home} v ${s.f.away}`,
    date: s.raw?.m.date,
    sourceScore: JSON.stringify(s.raw?.m.score),
    rejectCode: s.raw?.rejectCode,
    fplScore: `${s.f.homeScore}-${s.f.awayScore}`,
  }));
  const hiddenDifferent = hiddenDetail.filter((h) => h.fplScore !== '0-0').length;
  // A result for a match FPL does not call finished, or one that cannot have been played yet.
  const resultsNotFinishedInFpl = outcome.results.filter((r) => {
    const f = fplByKey.get(key(r.home, r.away));
    return f === undefined || !f.finished;
  });
  const resultsTooEarly = outcome.results.filter(
    (r) => r.kickoff.getTime() + 105 * 60_000 > now.getTime(),
  );

  // --- 3. half time & basis ----------------------------------------------------------------------
  const withHt = outcome.results.filter((r) => typeof r.score?.htHome === 'number');
  const htInconsistent = withHt.filter(
    (r) =>
      (r.score?.htHome ?? 0) > (r.score?.home ?? 0) ||
      (r.score?.htAway ?? 0) > (r.score?.away ?? 0),
  );
  const rawKeys = countBy(of.matches, (m) => {
    const s = m.score;
    if (s === undefined) return 'no score';
    if (Array.isArray(s)) return 'bare array';
    return `object:${Object.keys(s as object)
      .sort()
      .join('+')}`;
  });

  // --- 6. time handling ----------------------------------------------------------------------------
  const timeIssues = countBy(outcome.issues, (i) => `${i.severity}:${i.code}`);
  const midnight = of.matches.filter((m) => m.time === '00:00').length;
  const noTime = of.matches.filter((m) => m.time === undefined || m.time === null).length;

  // --- 1b. date differences (reschedules) --------------------------------------------------------
  const dateDiff = paired.filter(
    (r) =>
      new Date((r.fpl as Fpl).kickoff).toLocaleDateString('en-CA', {
        timeZone: 'Europe/London',
      }) !== r.m.date,
  );

  // Upcoming fixtures (FPL not finished) in the next 14 / 21 days: would the event carry the right kickoff?
  const upcoming = [14, 21].map((days) => {
    const lo = now.getTime() + 10 * 60_000;
    const hi = now.getTime() + days * 86_400_000;
    const f = fpl.filter(
      (x) => !x.finished && x.kickoff.getTime() > lo && x.kickoff.getTime() <= hi,
    );
    const withFixture = f.filter((x) => fixtures.has(key(x.home, x.away)));
    const exactNow = withFixture.filter(
      (x) => fixtures.get(key(x.home, x.away))?.kickoff.getTime() === x.kickoff.getTime(),
    );
    const dayWrong = withFixture.filter(
      (x) =>
        (fixtures.get(key(x.home, x.away))?.kickoff.toISOString().slice(0, 10) ?? '') !==
        x.kickoff.toISOString().slice(0, 10),
    );
    return {
      windowDays: days,
      fplFixtures: f.length,
      alsoAdapterFixtures: withFixture.length,
      kickoffExact: exactNow.length,
      kickoffWrong: withFixture.length - exactNow.length,
      utcDateWrong: dayWrong.length,
      earlierInFpl: withFixture.filter(
        (x) => (fixtures.get(key(x.home, x.away))?.kickoff.getTime() ?? 0) > x.kickoff.getTime(),
      ).length,
    };
  });
  return {
    season: seasonName,
    upcoming,
    source: { url, bytes: of.body.length, fileName: of.name, fetchedAtUsed: now.toISOString() },
    fixtures1: {
      openfootballRecords: of.matches.length,
      fplFixtures: fpl.length,
      pairedByHomeAway: rows.filter((r) => r.fpl !== undefined).length,
      onlyInOpenfootball: onlyOf.map((m) => key(m.team1, m.team2)),
      onlyInFpl: onlyFpl.map((f) => key(f.home, f.away)),
      duplicateOpenfootballKeys: duplicateOfKeys,
      adapterAccepted: { fixtures: outcome.fixtures.length, results: outcome.results.length },
      adapterDropped: rows.filter((r) => r.adapter === 'rejected').length,
      kickoffPaired: paired.length,
      kickoffExact: exact.length,
      kickoffExactRate: pct(exact.length, paired.length),
      kickoffDiffDistributionMin: countBy(diffs, (d) => String(d.min)),
      adapterKickoffDiffersFromDirectConversion: adapterVsRaw,
      kickoffMismatches: mismatches,
      kickoffMismatchesFinished: mismatches.filter((m) => m.finishedInFpl).length,
      dst,
      localDateDiffers: dateDiff.map((r) => ({
        match: `${r.m.team1} v ${r.m.team2}`,
        ofLocal: `${r.m.date} ${r.m.time}`,
        fpl: iso((r.fpl as Fpl).kickoff),
      })),
    },
    scores2: {
      fplFinished: finishedFpl.length,
      inBothWithAdapterResult: scoreBoth.length,
      equal: scoreEqual.length,
      equalRate: pct(scoreEqual.length, scoreBoth.length),
      mismatches: scoreMismatch,
      fplFinishedButNoAdapterResult: finishedNoResult.length,
      ofRecordRejectedHidingAFinishedMatch: hiddenDetail.length,
      hiddenResultsWhereFplIsNot00: hiddenDifferent,
      hiddenDetail: hiddenDetail.slice(0, 40),
      fplFinishedNotYetScoredInOpenfootball: notYetInOf.map((s) => ({
        match: `${s.f.home} v ${s.f.away}`,
        date: s.raw?.m.date,
        fpl: `${s.f.homeScore}-${s.f.awayScore}`,
      })),
      adapterResultsNotFinishedInFpl: resultsNotFinishedInFpl.length,
      adapterResultsBeforeKickoffPlus105min: resultsTooEarly.length,
      scheduledFixturesWhoseFplIsFinished: rows.filter(
        (r) => r.adapter === 'fixture' && r.fpl?.finished,
      ).length,
      parse: {
        recordsSeen: outcome.stats.recordsSeen,
        recordsAccepted: outcome.stats.recordsAccepted,
        rejected: outcome.stats.recordsSeen - outcome.stats.recordsAccepted,
        rejectedRate: pct(
          outcome.stats.recordsSeen - outcome.stats.recordsAccepted,
          outcome.stats.recordsSeen,
        ),
        issuesByCode: countBy(
          outcome.issues,
          (i) => `${i.severity}:${i.code}:${String(i.message).slice(0, 60)}`,
        ),
        rawScoreShapes: rawKeys,
      },
    },
    halfTime3: {
      results: outcome.results.length,
      withHalfTime: withHt.length,
      missingHalfTime: outcome.results.length - withHt.length,
      scoreBasis: countBy(outcome.results, (r) => r.scoreBasis),
      status: countBy(outcome.results, (r) => r.status),
      htExceedsFt: htInconsistent.length,
      rawRecordsWithEtOrPenalties: of.matches.filter(
        (m) =>
          typeof m.score === 'object' &&
          m.score !== null &&
          !Array.isArray(m.score) &&
          ('et' in m.score || 'p' in m.score),
      ).length,
    },
    time6: {
      missingTime: noTime,
      midnightPlaceholders: midnight,
      issuesByCode: timeIssues,
      distinctLocalTimes: countBy(of.matches, (m) => String(m.time)),
      rawVsAdapterConversion: adapterVsRaw,
      dateFormatOk: of.matches.filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date)).length,
    },
    normalizedFplNames: [...new Set(fpl.flatMap((f) => [f.home, f.away]))].map((n) =>
      normalizeName(n),
    ).length,
  };
}

const args = process.argv.slice(2);
const dir = requiredArg(args, 'data');
const out = requiredArg(args, 'out');
const now = new Date(argOf(args, 'now') ?? new Date().toISOString());
const result = {
  generatedAt: new Date().toISOString(),
  fetchTimeUsedForParsing: now.toISOString(),
  seasons: ['2025-26', '2026-27'].map((s) => season(dir, SOURCE_FILE, s, now)),
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${`wrote ${out}`}\n`);

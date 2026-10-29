import {
  backfilled,
  neutralStart,
  seededStart,
  teamsOf,
  walkForward,
  type PredRecord,
  type RatingMap,
  type World,
} from './odds-engine';
import {
  FOOTBALL_DATA_NAME,
  bootMean,
  bootstrap,
  brier2,
  brier3,
  loadOpenfootball,
  logLoss2,
  logLoss3,
  mean,
  num,
  out,
  readCsv,
  reliability,
  round,
  rps3,
  wilson,
  writeJson,
  type Interval,
  type MatchRow,
  type Probs3,
} from './odds-lib';

/**
 * Walk-forward backtest of the production pricing and rating loop.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/odds-backtest.ts <data-dir> <out.json>
 *
 * <data-dir> holds of/<season>_<league>.json (openfootball) and
 * odds/anish/data/processed/results.csv (football-data.co.uk scores, used only
 * to check the openfootball scores of the Premier League).
 */

const [dataDir, outPath] = process.argv.slice(2);
if (dataDir === undefined || outPath === undefined) {
  throw new Error('usage: odds-backtest.ts <data-dir> <out.json>');
}

interface SetDef {
  key: string;
  label: string;
  file: string;
  prev: string;
  n?: number;
}

const SETS: SetDef[] = [
  { key: 'PL2526', label: 'Premier League 2025-26', file: '2025-26_en.1', prev: '2024-25_en.1' },
  { key: 'PL2425', label: 'Premier League 2024-25', file: '2024-25_en.1', prev: '2023-24_en.1' },
  { key: 'ES2526', label: 'La Liga 2025-26', file: '2025-26_es.1', prev: '2024-25_es.1' },
  { key: 'DE2526', label: 'Bundesliga 2025-26', file: '2025-26_de.1', prev: '2024-25_de.1' },
  { key: 'IT2526', label: 'Serie A 2025-26', file: '2025-26_it.1', prev: '2024-25_it.1' },
  { key: 'FR2526', label: 'Ligue 1 2025-26', file: '2025-26_fr.1', prev: '2024-25_fr.1' },
];

const CONDITIONS = ['a_neutral', 'b_seeded', 'c_backfill'] as const;
type Condition = (typeof CONDITIONS)[number];

// ------------------------------------------------------------------ data + ground-truth check

const data = new Map<
  string,
  { matches: MatchRow[]; prev: MatchRow[]; info: Record<string, number> }
>();
for (const s of SETS) {
  const cur = loadOpenfootball(`${dataDir}/of/${s.file}.json`);
  const prev = loadOpenfootball(`${dataDir}/of/${s.prev}.json`);
  data.set(s.key, {
    matches: cur.matches,
    prev: prev.matches,
    info: {
      fileMatches: cur.total,
      properScores: cur.matches.filter((m) => m.visible).length,
      bareLists: cur.bareLists,
      bareNotZeroZero: cur.bareNotZeroZero,
      inferredZeroZero: cur.matches.filter((m) => m.inferred).length,
      unplayedOrMissing: cur.unplayed,
      prevMatches: prev.matches.length,
      prevInferred: prev.matches.filter((m) => m.inferred).length,
    },
  });
}

/** Cross-check of the Premier League scores with the football-data.co.uk results. */
function checkPremierLeague(season: string, rows: readonly MatchRow[]): Record<string, number> {
  const truth = new Map<string, [number, number]>();
  for (const r of readCsv(`${dataDir}/odds/anish/data/processed/results.csv`)) {
    if (r.season !== season) continue;
    const hg = num(r.fthg);
    const ag = num(r.ftag);
    if (hg !== null && ag !== null) truth.set(`${r.home_team}|${r.away_team}`, [hg, ag]);
  }
  let compared = 0;
  let mismatch = 0;
  let inferredOk = 0;
  let inferredBad = 0;
  for (const m of rows) {
    const t = truth.get(
      `${FOOTBALL_DATA_NAME[m.home] ?? m.home}|${FOOTBALL_DATA_NAME[m.away] ?? m.away}`,
    );
    if (t === undefined) continue;
    compared++;
    const same = t[0] === m.hg && t[1] === m.ag;
    if (!same) mismatch++;
    if (m.inferred) {
      if (same) inferredOk++;
      else inferredBad++;
    }
  }
  return {
    truthRows: truth.size,
    compared,
    mismatch,
    inferredZeroZeroConfirmed: inferredOk,
    inferredWrong: inferredBad,
  };
}

const groundTruth: Record<string, Record<string, number>> = {};
for (const [key, season] of [
  ['PL2526', '2025-26'],
  ['PL2425', '2024-25'],
] as const) {
  groundTruth[key] = checkPremierLeague(season, data.get(key)?.matches ?? []);
}

// ------------------------------------------------------------------ one run

function startFor(cond: Condition, set: SetDef, world: World): RatingMap {
  const d = data.get(set.key);
  if (d === undefined) throw new Error(set.key);
  if (cond === 'a_neutral') return neutralStart();
  if (cond === 'b_seeded') return seededStart(teamsOf(d.matches));
  return backfilled(d.prev, world);
}

interface Scored {
  records: PredRecord[];
  base: Probs3[];
  baseOver: number[];
  baseBtts: number[];
}

/** Walk-forward base-rate baselines (Laplace, learned from the matches before each one). */
function baselines(records: readonly PredRecord[]): Omit<Scored, 'records'> {
  const c = [1, 1, 1];
  let over = [1, 1];
  let btts = [1, 1];
  const base: Probs3[] = [];
  const baseOver: number[] = [];
  const baseBtts: number[] = [];
  for (const r of records) {
    const n = c[0]! + c[1]! + c[2]!;
    base.push([c[0]! / n, c[1]! / n, c[2]! / n]);
    baseOver.push(over[0]! / (over[0]! + over[1]!));
    baseBtts.push(btts[0]! / (btts[0]! + btts[1]!));
    c[r.outcome] = (c[r.outcome] ?? 0) + 1;
    over = r.hg + r.ag > 2.5 ? [over[0]! + 1, over[1]!] : [over[0]!, over[1]! + 1];
    btts = r.hg > 0 && r.ag > 0 ? [btts[0]! + 1, btts[1]!] : [btts[0]!, btts[1]! + 1];
  }
  return { base, baseOver, baseBtts };
}

const UNIFORM: Probs3 = [1 / 3, 1 / 3, 1 / 3];

function run(set: SetDef, cond: Condition, world: World): Scored {
  const d = data.get(set.key);
  if (d === undefined) throw new Error(set.key);
  const { records } = walkForward(d.matches, startFor(cond, set, world), { world });
  return { records, ...baselines(records) };
}

// ------------------------------------------------------------------ metrics

interface MetricSet {
  n: number;
  model: { brier: Interval; logLoss: Interval; rps: Interval };
  uniform: { brier: number; logLoss: number; rps: number };
  baseRate: { brier: number; logLoss: number; rps: number };
  vsBaseRate: { logLoss: Interval; rps: Interval; brier: Interval };
  vsUniform: { logLoss: Interval; rps: Interval };
}

function metrics(s: Scored, filter: (r: PredRecord) => boolean): MetricSet | null {
  const rows = s.records.map((r, i) => ({ r, b: s.base[i] ?? UNIFORM })).filter((x) => filter(x.r));
  if (rows.length < 2) return null;
  const f = (g: (p: Probs3, o: 0 | 1 | 2) => number, which: 'p' | 'b' | 'u'): number[] =>
    rows.map((x) => g(which === 'p' ? x.r.p : which === 'b' ? x.b : UNIFORM, x.r.outcome));
  const m = {
    brier: f(brier3, 'p'),
    ll: f(logLoss3, 'p'),
    rps: f(rps3, 'p'),
  };
  const b = { brier: f(brier3, 'b'), ll: f(logLoss3, 'b'), rps: f(rps3, 'b') };
  const u = { brier: f(brier3, 'u'), ll: f(logLoss3, 'u'), rps: f(rps3, 'u') };
  const diff = (x: number[], y: number[]): Interval =>
    bootstrap(x.length, (idx) => mean(idx.map((i) => (x[i] ?? 0) - (y[i] ?? 0))), 99);
  return {
    n: rows.length,
    model: { brier: bootMean(m.brier, 1), logLoss: bootMean(m.ll, 2), rps: bootMean(m.rps, 3) },
    uniform: { brier: mean(u.brier), logLoss: mean(u.ll), rps: mean(u.rps) },
    baseRate: { brier: mean(b.brier), logLoss: mean(b.ll), rps: mean(b.rps) },
    vsBaseRate: {
      logLoss: diff(m.ll, b.ll),
      rps: diff(m.rps, b.rps),
      brier: diff(m.brier, b.brier),
    },
    vsUniform: { logLoss: diff(m.ll, u.ll), rps: diff(m.rps, u.rps) },
  };
}

function compactMetrics(x: MetricSet | null): unknown {
  if (x === null) return null;
  const iv = (i: Interval): number[] => [round(i.value, 4), round(i.lo, 4), round(i.hi, 4)];
  return {
    n: x.n,
    brier: iv(x.model.brier),
    logLoss: iv(x.model.logLoss),
    rps: iv(x.model.rps),
    uniform: {
      brier: round(x.uniform.brier),
      logLoss: round(x.uniform.logLoss),
      rps: round(x.uniform.rps),
    },
    baseRate: {
      brier: round(x.baseRate.brier),
      logLoss: round(x.baseRate.logLoss),
      rps: round(x.baseRate.rps),
    },
    diffVsBaseRate: {
      logLoss: iv(x.vsBaseRate.logLoss),
      rps: iv(x.vsBaseRate.rps),
      brier: iv(x.vsBaseRate.brier),
    },
    diffVsUniform: { logLoss: iv(x.vsUniform.logLoss), rps: iv(x.vsUniform.rps) },
  };
}

function goalStats(
  rs: readonly PredRecord[],
  baseOver: readonly number[],
  baseBtts: readonly number[],
): unknown {
  const n = rs.length;
  const actualTotal = rs.map((r) => r.hg + r.ag);
  const predTotal = rs.map((r) => r.lamH + r.lamA);
  const overHit = rs.map((r) => r.hg + r.ag > 2.5);
  const withOver = rs.map((r, i) => ({ r, i })).filter((x) => x.r.over25 !== null);
  const withBtts = rs.map((r, i) => ({ r, i })).filter((x) => x.r.btts !== null);
  const bttsHit = (r: PredRecord): boolean => r.hg > 0 && r.ag > 0;
  const hg = mean(rs.map((r) => r.hg));
  const ag = mean(rs.map((r) => r.ag));
  const lh = mean(rs.map((r) => r.lamH));
  const la = mean(rs.map((r) => r.lamA));
  const k = overHit.filter(Boolean).length;
  const w = wilson(k, n);
  return {
    n,
    meanActualTotalGoals: round(mean(actualTotal), 3),
    meanPredictedTotalGoals: round(mean(predTotal), 3),
    totalGoalsBiasPred: bootstrap(
      n,
      (idx) => mean(idx.map((i) => (predTotal[i] ?? 0) - (actualTotal[i] ?? 0))),
      5,
    ),
    meanActualHome: round(hg, 3),
    meanActualAway: round(ag, 3),
    meanPredictedHome: round(lh, 3),
    meanPredictedAway: round(la, 3),
    homeAdvantageObservedRatio: round(hg / ag, 3),
    homeAdvantageImpliedRatio: round(lh / la, 3),
    over25: {
      n: withOver.length,
      predicted: round(mean(withOver.map((x) => x.r.over25 ?? 0)), 4),
      observed: round(k / n, 4),
      observedWilson95: [round(w.lo, 4), round(w.hi, 4)],
      brier: round(mean(withOver.map((x) => brier2(x.r.over25 ?? 0, overHit[x.i] ?? false))), 4),
      brierBaseRate: round(
        mean(withOver.map((x) => brier2(baseOver[x.i] ?? 0.5, overHit[x.i] ?? false))),
        4,
      ),
      logLoss: round(
        mean(withOver.map((x) => logLoss2(x.r.over25 ?? 0, overHit[x.i] ?? false))),
        4,
      ),
      logLossBaseRate: round(
        mean(withOver.map((x) => logLoss2(baseOver[x.i] ?? 0.5, overHit[x.i] ?? false))),
        4,
      ),
    },
    btts: {
      n: withBtts.length,
      predicted: round(mean(withBtts.map((x) => x.r.btts ?? 0)), 4),
      observed: round(mean(withBtts.map((x) => (bttsHit(x.r) ? 1 : 0))), 4),
      brier: round(mean(withBtts.map((x) => brier2(x.r.btts ?? 0, bttsHit(x.r)))), 4),
      brierBaseRate: round(
        mean(withBtts.map((x) => brier2(baseBtts[x.i] ?? 0.5, bttsHit(x.r)))),
        4,
      ),
      logLoss: round(mean(withBtts.map((x) => logLoss2(x.r.btts ?? 0, bttsHit(x.r)))), 4),
      logLossBaseRate: round(
        mean(withBtts.map((x) => logLoss2(baseBtts[x.i] ?? 0.5, bttsHit(x.r)))),
        4,
      ),
    },
  };
}

/** Flat-stake return of backing a selection at the offered odds (a bettor's view of the price). */
function roiStats(rs: readonly PredRecord[]): unknown {
  const one = (k: 0 | 1 | 2): Interval =>
    bootstrap(
      rs.length,
      (idx) => mean(idx.map((i) => (rs[i]?.outcome === k ? (rs[i]?.odds1x2[k] ?? 0) : 0) - 1)),
      40 + k,
    );
  const all = bootstrap(
    rs.length,
    (idx) =>
      mean(
        idx.map((i) => {
          const r = rs[i];
          return r === undefined ? 0 : r.odds1x2[r.outcome] / 3 - 1;
        }),
      ),
    50,
  );
  const overround = mean(rs.map((r) => r.odds1x2.reduce((a, o) => a + 1 / o, 0) - 1));
  const f = (i: Interval): number[] => [round(i.value, 4), round(i.lo, 4), round(i.hi, 4)];
  return {
    n: rs.length,
    meanOverround1x2: round(overround, 4),
    roiBackHome: f(one(0)),
    roiBackDraw: f(one(1)),
    roiBackAway: f(one(2)),
    roiBackEveryOutcomeOnce: f(all),
  };
}

function reliabilityTables(rs: readonly PredRecord[]): unknown {
  const tab = (k: 0 | 1 | 2): ReturnType<typeof reliability> =>
    reliability(
      rs.map((r) => r.p[k]),
      rs.map((r) => r.outcome === k),
    );
  const home = tab(0);
  const draw = tab(1);
  const away = tab(2);
  // Pooled over the three outcomes (every match contributes three probabilities).
  const pooled = reliability(
    rs.flatMap((r) => [r.p[0], r.p[1], r.p[2]]),
    rs.flatMap((r) => [r.outcome === 0, r.outcome === 1, r.outcome === 2]),
  );
  const slim = (x: ReturnType<typeof reliability>): unknown => ({
    n: x.n,
    bins: x.bins,
    ecePp: [round(x.eceInterval.value, 2), round(x.eceInterval.lo, 2), round(x.eceInterval.hi, 2)],
    biasPp: [round(x.biasPp.value, 2), round(x.biasPp.lo, 2), round(x.biasPp.hi, 2)],
    meanPredicted: round(x.meanPredicted, 4),
    observedRate: round(x.observedRate, 4),
    maxDeviationPpN30: x.maxDeviationPpN30,
  });
  return { home: slim(home), draw: slim(draw), away: slim(away), pooled: slim(pooled) };
}

/** Month of the season: 1 = August. */
function seasonMonth(date: string): number {
  const m = Number(date.slice(5, 7));
  return ((m + 4) % 12) + 1;
}

function learningCurve(scored: readonly Scored[]): unknown {
  const buckets = new Map<
    number,
    { ll: number[]; rps: number[]; llBase: number[]; rpsBase: number[] }
  >();
  for (const s of scored) {
    s.records.forEach((r, i) => {
      const k = seasonMonth(r.date);
      const b = buckets.get(k) ?? { ll: [], rps: [], llBase: [], rpsBase: [] };
      const base = s.base[i] ?? UNIFORM;
      b.ll.push(logLoss3(r.p, r.outcome));
      b.rps.push(rps3(r.p, r.outcome));
      b.llBase.push(logLoss3(base, r.outcome));
      b.rpsBase.push(rps3(base, r.outcome));
      buckets.set(k, b);
    });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({
      seasonMonth: k,
      n: b.ll.length,
      logLoss: round(mean(b.ll)),
      logLossBaseRate: round(mean(b.llBase)),
      rps: round(mean(b.rps)),
      rpsBaseRate: round(mean(b.rpsBase)),
    }));
}

// ------------------------------------------------------------------ main

const result: Record<string, unknown> = {
  generatedFor: 'odds-backtest.ts',
  dataInfo: Object.fromEntries([...data.entries()].map(([k, v]) => [k, v.info])),
  groundTruthCheck: groundTruth,
  runs: {} as Record<string, unknown>,
};
const runs = result.runs as Record<string, unknown>;

const pooled = new Map<string, Scored[]>(); // `${world}|${cond}` -> sets
for (const world of ['truth', 'visible'] as const) {
  for (const cond of CONDITIONS) {
    for (const set of SETS) {
      const s = run(set, cond, world);
      const key = `${set.key}|${cond}|${world}`;
      const eligible = (r: PredRecord): boolean => r.eligible;
      runs[key] = {
        set: set.label,
        condition: cond,
        world,
        all: compactMetrics(metrics(s, () => true)),
        eligibleO1: compactMetrics(metrics(s, eligible)),
        goals: goalStats(s.records, s.baseOver, s.baseBtts),
        roi1x2: roiStats(s.records),
        eligibleCount: s.records.filter(eligible).length,
        ...(world === 'truth' && (set.key === 'PL2526' || set.key === 'PL2425')
          ? { reliability: reliabilityTables(s.records), learningCurve: learningCurve([s]) }
          : {}),
      };
      const pk = `${world}|${cond}`;
      pooled.set(pk, [...(pooled.get(pk) ?? []), s]);
    }
  }
}

for (const [pk, list] of pooled) {
  const [world, cond] = pk.split('|');
  const merged: Scored = {
    records: list.flatMap((s) => s.records),
    base: list.flatMap((s) => s.base),
    baseOver: list.flatMap((s) => s.baseOver),
    baseBtts: list.flatMap((s) => s.baseBtts),
  };
  const eligible = (r: PredRecord): boolean => r.eligible;
  runs[`POOL|${cond}|${world}`] = {
    set: 'all six league-seasons pooled',
    condition: cond,
    world,
    all: compactMetrics(metrics(merged, () => true)),
    eligibleO1: compactMetrics(metrics(merged, eligible)),
    goals: goalStats(merged.records, merged.baseOver, merged.baseBtts),
    roi1x2: roiStats(merged.records),
    eligibleCount: merged.records.filter(eligible).length,
    ...(world === 'truth'
      ? {
          reliability: reliabilityTables(merged.records),
          reliabilityEligible: reliabilityTables(merged.records.filter(eligible)),
          learningCurve: learningCurve(list),
        }
      : {}),
  };
}

writeJson(outPath, result);

// ------------------------------------------------------------------ console summary

out('ground truth check: ' + JSON.stringify(groundTruth));
out('data: ' + JSON.stringify(result.dataInfo));
for (const key of Object.keys(runs)) {
  const r = runs[key] as {
    all: {
      n: number;
      logLoss: number[];
      rps: number[];
      brier: number[];
      baseRate: { logLoss: number };
    } | null;
  };
  if (r.all === null) continue;
  out(
    `${key.padEnd(24)} n=${r.all.n} LL=${r.all.logLoss[0]} (base ${r.all.baseRate.logLoss}) RPS=${r.all.rps[0]} Brier=${r.all.brier[0]}`,
  );
}

import {
  HOME_ADVANTAGE_KEY,
  addHomeAdvantageResult,
  learnedHomeAdvantage,
  priceFixture,
  updateFootballRatings,
  withHomeAdvantage,
  type FeedMarket,
  type HomeAdvantageEvidence,
} from '@vamos/feed';
import {
  bootstrap,
  loadOpenfootball,
  logLoss2,
  logLoss3,
  mean,
  normalise3,
  out,
  outcomeOf,
  proportional,
  round,
  writeJson,
  type Interval,
  type MatchRow,
  type Ratings,
} from './odds-lib';

/**
 * F-07: a per-competition home advantage learned from results, OUT OF SAMPLE.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/odds-homeadv.ts <data-dir> <out.json>
 *
 * Every number is causal: the home advantage used for a match is computed from the finished
 * results of the same competition before it, never from the match itself or a later one.
 * The production code paths are used as they are: `priceFixture` prices from the ratings
 * (reading `homeAdvantage` from the home team's ratings) and `updateFootballRatings` learns with
 * the same value. As the results pipeline does after every applied result, the evidence (home
 * goals, away goals, matches of the competition) is updated and the new value is written on the
 * ratings of the two teams that played; so a team's stored value can lag the competition's.
 *
 * Two ways to start, both reported:
 *  - "season 2": the system already has a season of the competition's results (the previous
 *    season was run through the same pipeline, and earlier seasons count as evidence);
 *  - "season 1": the worst case, no earlier evidence at all. Ratings are backfilled with the
 *    constant (what `ratings backfill` does), and the evidence is only the test season so far.
 *
 * Out of sample: the prior weight is CHOSEN on the 2024-25 season (training) and REPORTED on
 * 2025-26 (test), whose estimates only see 2024-25 and earlier results plus the 2025-26
 * matches played so far. The constant 1.15 is the baseline. Paired bootstrap over matches.
 */

const [dataDir, outPath] = process.argv.slice(2);
if (dataDir === undefined || outPath === undefined) {
  throw new Error('usage: odds-homeadv.ts <data-dir> <out.json>');
}

interface League {
  key: string;
  code: string;
  /** Seasons available, oldest first. */
  seasons: string[];
}
const LEAGUES: League[] = [
  { key: 'PL', code: 'en.1', seasons: ['2023-24', '2024-25', '2025-26'] },
  { key: 'ES', code: 'es.1', seasons: ['2023-24', '2024-25', '2025-26'] },
  { key: 'DE', code: 'de.1', seasons: ['2024-25', '2025-26'] },
  { key: 'IT', code: 'it.1', seasons: ['2024-25', '2025-26'] },
  { key: 'FR', code: 'fr.1', seasons: ['2024-25', '2025-26'] },
];

const load = (season: string, code: string): MatchRow[] =>
  loadOpenfootball(`${dataDir}/of/${season}_${code}.json`).matches;

type Start = 'season2' | 'season1';
interface Policy {
  name: string;
  /** null = the constant (nothing is stored on the ratings). */
  priorMatches: number | null;
}
const CONSTANT: Policy = { name: 'constant 1.15 (today)', priorMatches: null };
const learned = (n0: number): Policy => ({ name: `learned n0=${n0}`, priorMatches: n0 });

interface Scored {
  ll1x2: number;
  llOver: number | null;
  llBtts: number | null;
  goals: number;
  lamTotal: number;
  ha: number;
}

const oddsOf = (
  books: readonly FeedMarket[],
  type: string,
  line: string | null,
  codes: string[],
): number[] | null => {
  const market = books.find((x) => x.type === type && x.line === line);
  if (market === undefined) return null;
  const prices = codes.map((c) => market.selections.find((s) => s.code === c)?.oddsMilli);
  return prices.some((x) => x === undefined) ? null : prices.map((x) => (x as number) / 1000);
};

/**
 * One league and one test season. `prev` is replayed first from neutral ratings (the
 * backfill), `earlier` are older results that only count as evidence.
 */
function run(
  test: readonly MatchRow[],
  prev: readonly MatchRow[],
  earlier: readonly MatchRow[],
  policy: Policy,
  start: Start,
): Scored[] {
  const ratings = new Map<string, Ratings>();
  let evidence: HomeAdvantageEvidence = { matches: 0, homeGoals: 0, awayGoals: 0 };
  const learnedStart = policy.priorMatches !== null && start === 'season2';
  if (learnedStart)
    for (const m of earlier) evidence = addHomeAdvantageResult(evidence, m.hg, m.ag);

  /** The results pipeline: update both teams' ratings, then the evidence, then write the new value. */
  const apply = (m: MatchRow, learn: boolean): void => {
    const h = ratings.get(m.home) ?? null;
    const a = ratings.get(m.away) ?? null;
    const next = updateFootballRatings(h, a, { home: m.hg, away: m.ag });
    let home: Ratings = next.home;
    let away: Ratings = next.away;
    if (learn && policy.priorMatches !== null) {
      evidence = addHomeAdvantageResult(evidence, m.hg, m.ag);
      const value = learnedHomeAdvantage(evidence, { priorMatches: policy.priorMatches });
      home = withHomeAdvantage(home, value);
      away = withHomeAdvantage(away, value);
    }
    ratings.set(m.home, home);
    ratings.set(m.away, away);
  };

  // Season 2: the previous season goes through the pipeline too. Season 1: it is the
  // constant backfill and the evidence starts with the test season.
  for (const m of prev) apply(m, learnedStart);

  const scored: Scored[] = [];
  for (const m of test) {
    const h = ratings.get(m.home) ?? null;
    const a = ratings.get(m.away) ?? null;
    const books = priceFixture('football', h, a);
    const one = oddsOf(books, '1x2', null, ['1', 'X', '2']);
    if (one === null) throw new Error('1x2 missing');
    const p3 = proportional(one);
    const p = normalise3([p3[0] ?? 0, p3[1] ?? 0, p3[2] ?? 0]);
    const over = oddsOf(books, 'ou', '2.5', ['over', 'under']);
    const btts = oddsOf(books, 'btts', null, ['yes', 'no']);
    const overP = over === null ? null : (proportional(over)[0] ?? null);
    const bttsP = btts === null ? null : (proportional(btts)[0] ?? null);
    scored.push({
      ll1x2: logLoss3(p, outcomeOf(m.hg, m.ag)),
      llOver: overP === null ? null : logLoss2(overP, m.hg + m.ag > 2.5),
      llBtts: bttsP === null ? null : logLoss2(bttsP, m.hg > 0 && m.ag > 0),
      goals: m.hg + m.ag,
      lamTotal: 0,
      ha: h?.[HOME_ADVANTAGE_KEY] ?? 1.15,
    });
    apply(m, true);
  }
  return scored;
}

interface Cell {
  league: string;
  scored: Scored[];
}

function evaluate(policy: Policy, season: string, start: Start): Cell[] {
  const cells: Cell[] = [];
  for (const league of LEAGUES) {
    const at = league.seasons.indexOf(season);
    if (at < 0) continue;
    const prevSeason = league.seasons[at - 1];
    const prev = prevSeason === undefined ? [] : load(prevSeason, league.code);
    const earlier = league.seasons
      .slice(0, Math.max(0, at - 1))
      .flatMap((s) => load(s, league.code));
    cells.push({
      league: league.key,
      scored: run(load(season, league.code), prev, earlier, policy, start),
    });
  }
  return cells;
}

const flat = (cells: Cell[]): Scored[] => cells.flatMap((c) => c.scored);
const paired = (a: number[], b: number[], seed: number): Interval =>
  bootstrap(a.length, (idx) => mean(idx.map((i) => (a[i] ?? 0) - (b[i] ?? 0))), seed);
const present = (rows: Array<number | null>, ref: Array<number | null>): [number[], number[]] => {
  const a: number[] = [];
  const b: number[] = [];
  rows.forEach((v, i) => {
    const r = ref[i];
    if (v !== null && r !== null && r !== undefined) {
      a.push(v);
      b.push(r);
    }
  });
  return [a, b];
};

function report(policy: Policy, base: Cell[], cells: Cell[], seed: number) {
  const rows = flat(cells);
  const ref = flat(base);
  const a = rows.map((s) => s.ll1x2);
  const b = ref.map((s) => s.ll1x2);
  const [overA, overB] = present(
    rows.map((s) => s.llOver),
    ref.map((s) => s.llOver),
  );
  const [bttsA, bttsB] = present(
    rows.map((s) => s.llBtts),
    ref.map((s) => s.llBtts),
  );
  return {
    policy: policy.name,
    n: rows.length,
    logLoss1x2: round(mean(a), 5),
    logLoss1x2Constant: round(mean(b), 5),
    diffVsConstant: paired(a, b, seed),
    logLossOver25Diff: paired(overA, overB, seed + 1),
    logLossBttsDiff: paired(bttsA, bttsB, seed + 2),
    meanHomeAdvantage: round(mean(rows.map((s) => s.ha)), 4),
    perLeague: cells.map((c, i) => ({
      league: c.league,
      n: c.scored.length,
      logLoss1x2: round(mean(c.scored.map((s) => s.ll1x2)), 5),
      constant: round(mean((base[i]?.scored ?? []).map((s) => s.ll1x2)), 5),
      meanHomeAdvantage: round(mean(c.scored.map((s) => s.ha)), 4),
    })),
  };
}

// ------------------------------------------------------------------ observed home advantage

const observed: Record<string, unknown> = {};
for (const league of LEAGUES) {
  for (const season of league.seasons) {
    const m = load(season, league.code);
    const h = m.reduce((s, x) => s + x.hg, 0);
    const a = m.reduce((s, x) => s + x.ag, 0);
    observed[`${league.key} ${season}`] = {
      matches: m.length,
      homeGoals: h,
      awayGoals: a,
      ratio: round(h / a, 4),
      goalsPerMatch: round((h + a) / m.length, 3),
    };
  }
}

// ------------------------------------------------------------------ choose on 2024-25, report on 2025-26

const candidates: Policy[] = [CONSTANT, learned(100), learned(200), learned(400), learned(800)];
const results: Record<string, unknown> = {};
let chosen: Policy = learned(400);
for (const [label, season, start] of [
  ['training 2024-25, season 2 (earlier evidence where the data has it)', '2024-25', 'season2'],
  ['test 2025-26, season 2', '2025-26', 'season2'],
  ['test 2025-26, season 1 (no earlier evidence)', '2025-26', 'season1'],
] as const) {
  const cells = new Map(candidates.map((p) => [p.name, evaluate(p, season, start)]));
  const base = cells.get(CONSTANT.name) ?? [];
  const reports = candidates.map((p) => report(p, base, cells.get(p.name) ?? [], 31));
  results[label] = reports;
  if (season === '2024-25') {
    // The rule is fixed before the test: the lowest training log-loss among the learned policies.
    const best = reports.slice(1).sort((x, y) => x.logLoss1x2 - y.logLoss1x2)[0];
    chosen = candidates.find((p) => p.name === best?.policy) ?? chosen;
  }
  out(label);
  for (const r of reports) {
    const d = r.diffVsConstant;
    const o = r.logLossOver25Diff;
    out(
      `  ${r.policy.padEnd(22)} n=${r.n} LL1x2=${r.logLoss1x2} (constant ${r.logLoss1x2Constant}) diff ${round(d.value, 5)} [${round(d.lo, 5)}, ${round(d.hi, 5)}]  over2.5 diff ${round(o.value, 5)}  meanHA ${r.meanHomeAdvantage}`,
    );
  }
}
out(`chosen on training: ${chosen.name}`);
writeJson(outPath, { observed, chosenOnTraining: chosen.name, results });
out(
  `observed home/away goal ratios: ${JSON.stringify(Object.fromEntries(Object.entries(observed).map(([k, v]) => [k, (v as { ratio: number }).ratio])))}`,
);

import {
  priceFixture,
  updateFootballRatings,
  type FeedMarket,
  type RatingUpdateOptions,
} from '@vamos/feed';
import { checkReprice, isCalibrated, MAX_PRICE_MOVE_RATIO } from '@vamos/scraper';
import { backfilled, neutralStart, walkForward, type RatingMap } from './odds-engine';
import {
  bootMean,
  loadOpenfootball,
  logLoss3,
  mean,
  out,
  round,
  writeJson,
  type MatchRow,
} from './odds-lib';

/**
 * Re-pricing volatility (rule O3) and the learning-rate sweep.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/odds-volatility.ts <data-dir> <out.json>
 *
 * Replays a season in time order. A fixture's event exists from 28 days before
 * kickoff (LOOK_AHEAD_MS = FIXTURE_HORIZON_MS + 14 days) to 10 minutes before
 * (MIN_LEAD_MS). Every result changes the ratings fingerprint of both teams, so
 * each open event of those teams is priced again and checked with the
 * production checkReprice. Two trader behaviours: "approves" (a held proposal
 * is applied, so the next comparison starts from it) and "ignores" (the old
 * prices stay, drift accumulates, as when nobody opens the queue).
 */

const [dataDir, outPath] = process.argv.slice(2);
if (dataDir === undefined || outPath === undefined) {
  throw new Error('usage: odds-volatility.ts <data-dir> <out.json>');
}

const DAY = 86_400_000;
const WINDOW = 28 * DAY;
const MIN_LEAD = 10 * 60_000;
const RESULT_LAG = 2 * 3_600_000;

const SETS = [
  { key: 'PL2526', file: '2025-26_en.1', prev: '2024-25_en.1' },
  { key: 'PL2425', file: '2024-25_en.1', prev: '2023-24_en.1' },
] as const;
const SWEEP_SETS = [
  { key: 'PL2526', file: '2025-26_en.1', prev: '2024-25_en.1' },
  { key: 'PL2425', file: '2024-25_en.1', prev: '2023-24_en.1' },
  { key: 'ES2526', file: '2025-26_es.1', prev: '2024-25_es.1' },
  { key: 'DE2526', file: '2025-26_de.1', prev: '2024-25_de.1' },
  { key: 'IT2526', file: '2025-26_it.1', prev: '2024-25_it.1' },
  { key: 'FR2526', file: '2025-26_fr.1', prev: '2024-25_fr.1' },
] as const;

const kickoff = (m: MatchRow): number => Date.parse(`${m.date}T${m.time}:00Z`);

function maxRatio(
  prev: readonly FeedMarket[],
  next: readonly FeedMarket[],
  only1x2: boolean,
): number {
  let worst = 1;
  for (const n of next) {
    if (only1x2 && n.type !== '1x2') continue;
    const p = prev.find((x) => x.type === n.type && x.line === n.line);
    if (p === undefined) continue;
    for (const s of n.selections) {
      const o = p.selections.find((x) => x.code === s.code);
      if (o === undefined) continue;
      worst = Math.max(worst, s.oddsMilli / o.oddsMilli, o.oddsMilli / s.oddsMilli);
    }
  }
  return worst;
}

interface Check {
  ratioAll: number;
  ratio1x2: number;
  held: boolean;
  nextMatch: boolean;
  round: string;
  event: number;
  codes: string[];
}

function simulate(
  matches: readonly MatchRow[],
  start: RatingMap,
  approves: boolean,
  update?: RatingUpdateOptions,
): Check[] {
  const ratings: RatingMap = new Map(start);
  type Ev = { t: number; kind: 'create' | 'result'; i: number };
  const events: Ev[] = [];
  matches.forEach((m, i) => {
    events.push({ t: kickoff(m) - WINDOW, kind: 'create', i });
    events.push({ t: kickoff(m) + RESULT_LAG, kind: 'result', i });
  });
  events.sort((a, b) => a.t - b.t || (a.kind === 'create' ? -1 : 1));
  const stored = new Map<number, FeedMarket[]>();
  const checks: Check[] = [];
  const done = new Set<number>();
  for (const ev of events) {
    const m = matches[ev.i];
    if (m === undefined) continue;
    if (ev.kind === 'create') {
      stored.set(
        ev.i,
        priceFixture('football', ratings.get(m.home) ?? null, ratings.get(m.away) ?? null),
      );
      continue;
    }
    const next = updateFootballRatings(
      ratings.get(m.home) ?? null,
      ratings.get(m.away) ?? null,
      { home: m.hg, away: m.ag },
      update ?? {},
    );
    ratings.set(m.home, next.home);
    ratings.set(m.away, next.away);
    done.add(ev.i);
    const open = [...stored.keys()].filter((j) => {
      const f = matches[j];
      return (
        f !== undefined &&
        !done.has(j) &&
        kickoff(f) - MIN_LEAD > ev.t &&
        (f.home === m.home || f.home === m.away || f.away === m.home || f.away === m.away)
      );
    });
    for (const j of open) {
      const f = matches[j];
      const old = stored.get(j);
      if (f === undefined || old === undefined) continue;
      const h = ratings.get(f.home) ?? null;
      const a = ratings.get(f.away) ?? null;
      if (!isCalibrated(h, 8) || !isCalibrated(a, 8)) continue; // O1: never re-priced
      const proposal = priceFixture('football', h, a);
      const verdict = checkReprice(old, proposal);
      // The next match of a team: no earlier open event of that team.
      const teams = [f.home, f.away].filter((t) => t === m.home || t === m.away);
      const isNext = teams.some(
        (t) =>
          !open.some((k) => {
            const g = matches[k];
            return (
              g !== undefined &&
              k !== j &&
              (g.home === t || g.away === t) &&
              kickoff(g) < kickoff(f)
            );
          }),
      );
      checks.push({
        ratioAll: maxRatio(old, proposal, false),
        ratio1x2: maxRatio(old, proposal, true),
        held: !verdict.ok,
        nextMatch: isNext,
        round: m.round,
        event: j,
        codes: verdict.ok ? [] : [...new Set(verdict.issues.map((x) => x.code))],
      });
      if (verdict.ok || approves) stored.set(j, proposal);
    }
  }
  return checks;
}

function q(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? Number.NaN;
}

function summary(checks: readonly Check[]): unknown {
  const sel = (rows: readonly Check[]): unknown => {
    const n = rows.length;
    const held = rows.filter((c) => c.held);
    const events = new Set(held.map((c) => c.event));
    const byRound = new Map<string, Set<number>>();
    for (const c of held) byRound.set(c.round, (byRound.get(c.round) ?? new Set()).add(c.event));
    const rounds = new Set(rows.map((c) => c.round));
    const codes: Record<string, number> = {};
    for (const c of held) for (const code of c.codes) codes[code] = (codes[code] ?? 0) + 1;
    const rr = rows.map((c) => c.ratioAll);
    const r1 = rows.map((c) => c.ratio1x2);
    return {
      repriceChecks: n,
      held: held.length,
      heldShare: round(held.length / Math.max(1, n), 4),
      heldShare1x2Only: round(
        rows.filter((c) => c.ratio1x2 > MAX_PRICE_MOVE_RATIO).length / Math.max(1, n),
        4,
      ),
      maxRatioAllMarkets: {
        p50: round(q(rr, 0.5), 4),
        p90: round(q(rr, 0.9), 4),
        p99: round(q(rr, 0.99), 4),
        max: round(Math.max(...rr), 3),
      },
      maxRatio1x2: {
        p50: round(q(r1, 0.5), 4),
        p90: round(q(r1, 0.9), 4),
        p99: round(q(r1, 0.99), 4),
        max: round(Math.max(...r1), 3),
      },
      distinctEventsHeld: events.size,
      roundsObserved: rounds.size,
      meanDistinctEventsHeldPerRound: round(
        mean([...rounds].map((r) => byRound.get(r)?.size ?? 0)),
        2,
      ),
      heldByIssueCode: codes,
    };
  };
  return { all: sel(checks), nextMatchOnly: sel(checks.filter((c) => c.nextMatch)) };
}

const result: Record<string, unknown> = {
  windowDays: 28,
  maxPriceMoveRatio: MAX_PRICE_MOVE_RATIO,
  runs: {},
  sweep: {},
};
const runs = result.runs as Record<string, unknown>;
for (const s of SETS) {
  const cur = loadOpenfootball(`${dataDir}/of/${s.file}.json`).matches;
  const prev = loadOpenfootball(`${dataDir}/of/${s.prev}.json`).matches;
  for (const approves of [true, false]) {
    runs[`${s.key}|c_backfill|${approves ? 'trader_approves' : 'trader_ignores'}`] = summary(
      simulate(cur, backfilled(prev, 'truth'), approves),
    );
  }
  runs[`${s.key}|a_neutral|trader_approves`] = summary(simulate(cur, neutralStart(), true));
}

// Learning-rate sweep: log-loss on all six league-seasons, and re-price holds on the Premier League.
const loaded = SWEEP_SETS.map((s) => ({
  ...s,
  cur: loadOpenfootball(`${dataDir}/of/${s.file}.json`).matches,
  prev: loadOpenfootball(`${dataDir}/of/${s.prev}.json`).matches,
}));
const grid: Array<{ kMin: number; kOffset: number }> = [];
for (const kMin of [0.01, 0.02, 0.035, 0.05, 0.08, 0.12, 0.2]) grid.push({ kMin, kOffset: 6 });
for (const kOffset of [3, 12, 24]) grid.push({ kMin: 0.05, kOffset });
const sweep: unknown[] = [];
for (const g of grid) {
  const opts: RatingUpdateOptions = { kMin: g.kMin, kOffset: g.kOffset };
  const llC: number[] = [];
  const llA: number[] = [];
  for (const s of loaded) {
    for (const r of walkForward(s.cur, backfilled(s.prev, 'truth', opts), { update: opts }).records)
      llC.push(logLoss3(r.p, r.outcome));
    for (const r of walkForward(s.cur, neutralStart(), { update: opts }).records)
      llA.push(logLoss3(r.p, r.outcome));
  }
  const holds = loaded
    .slice(0, 2)
    .map((s) => simulate(s.cur, backfilled(s.prev, 'truth', opts), true, opts))
    .flat();
  const nextOnly = holds.filter((c) => c.nextMatch);
  sweep.push({
    kMin: g.kMin,
    kOffset: g.kOffset,
    isDefault: g.kMin === 0.05 && g.kOffset === 6,
    n: llC.length,
    logLossBackfill: bootMean(llC, 7),
    logLossNeutral: bootMean(llA, 8),
    heldShareAllEvents: round(holds.filter((c) => c.held).length / holds.length, 4),
    heldShareNextMatch: round(
      nextOnly.filter((c) => c.held).length / Math.max(1, nextOnly.length),
      4,
    ),
  });
}
result.sweep = sweep;
writeJson(outPath, result);
out(JSON.stringify(runs['PL2526|c_backfill|trader_approves']));
out(JSON.stringify(runs['PL2526|c_backfill|trader_ignores']));
for (const s of sweep as Array<Record<string, unknown>>) {
  const b = s.logLossBackfill as { value: number };
  const a = s.logLossNeutral as { value: number };
  out(
    `kMin ${String(s.kMin)} kOffset ${String(s.kOffset)} LL(c) ${round(b.value, 4)} LL(a) ${round(a.value, 4)} held ${String(s.heldShareAllEvents)} / next ${String(s.heldShareNextMatch)}`,
  );
}

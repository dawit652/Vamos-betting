import {
  backfilled,
  neutralStart,
  seededStart,
  teamsOf,
  walkForward,
  type PredRecord,
} from './odds-engine';
import {
  FOOTBALL_DATA_NAME,
  bootstrap,
  brier2,
  brier3,
  loadOpenfootball,
  logLoss2,
  logLoss3,
  mean,
  normalise3,
  num,
  out,
  power,
  proportional,
  readCsv,
  round,
  rps3,
  writeJson,
  type Interval,
  type Probs3,
} from './odds-lib';

/**
 * Model against the bookmaker closing line (Premier League 2024-25 and 2025-26).
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/odds-market.ts <data-dir> <out.json>
 *
 * Closing odds: AnishKhetani/premier-league-data (a football-data.co.uk
 * mirror), columns market_avg_*_close (average of the bookmakers football-data
 * tracks), pinnacle_*_close and bet365_*_close. The file is not copied into
 * the repository, only aggregates are published.
 */

const [dataDir, outPath] = process.argv.slice(2);
if (dataDir === undefined || outPath === undefined) {
  throw new Error('usage: odds-market.ts <data-dir> <out.json>');
}

const odds = readCsv(`${dataDir}/odds/anish/data/processed/results_with_odds.csv`);
const SEASONS = [
  { key: 'PL2425', season: '2024-25', file: '2024-25_en.1', prev: '2023-24_en.1' },
  { key: 'PL2526', season: '2025-26', file: '2025-26_en.1', prev: '2024-25_en.1' },
] as const;
const CONDS = ['a_neutral', 'b_seeded', 'c_backfill'] as const;

type Source = 'market_avg' | 'pinnacle' | 'bet365';
const SOURCES: Source[] = ['market_avg', 'pinnacle', 'bet365'];

interface Joined {
  rec: Record<(typeof CONDS)[number], PredRecord>;
  key: string;
  outcome: 0 | 1 | 2;
  mkt: Partial<Record<Source, [number, number, number]>>;
  ou: Partial<Record<Source, [number, number]>>;
  datesDiffer: boolean;
}

const joinInfo: Record<string, unknown> = {};
const joined: Joined[] = [];

for (const s of SEASONS) {
  const cur = loadOpenfootball(`${dataDir}/of/${s.file}.json`);
  const prev = loadOpenfootball(`${dataDir}/of/${s.prev}.json`);
  const runs = {
    a_neutral: walkForward(cur.matches, neutralStart()).records,
    b_seeded: walkForward(cur.matches, seededStart(teamsOf(cur.matches))).records,
    c_backfill: walkForward(cur.matches, backfilled(prev.matches, 'truth')).records,
  };
  const byPair = new Map<string, Record<string, string>>();
  const dup = new Set<string>();
  for (const r of odds) {
    if (r.season !== s.season) continue;
    const k = `${r.home_team}|${r.away_team}`;
    if (byPair.has(k)) dup.add(k);
    byPair.set(k, r);
  }
  let matched = 0;
  let datesDiffer = 0;
  const missing: string[] = [];
  cur.matches.forEach((m, i) => {
    const hk = FOOTBALL_DATA_NAME[m.home];
    const ak = FOOTBALL_DATA_NAME[m.away];
    const row = hk === undefined || ak === undefined ? undefined : byPair.get(`${hk}|${ak}`);
    if (row === undefined) {
      missing.push(`${m.home} v ${m.away}`);
      return;
    }
    matched++;
    const differ = row.date !== m.date;
    if (differ) datesDiffer++;
    const triple = (a: string, b: string, c: string): [number, number, number] | undefined => {
      const x = num(row[a]);
      const y = num(row[b]);
      const z = num(row[c]);
      return x === null || y === null || z === null ? undefined : [x, y, z];
    };
    const two = (a: string, b: string): [number, number] | undefined => {
      const x = num(row[a]);
      const y = num(row[b]);
      return x === null || y === null ? undefined : [x, y];
    };
    const mkt: Joined['mkt'] = {};
    const ou: Joined['ou'] = {};
    for (const src of SOURCES) {
      const t = triple(`${src}_1x2_home_close`, `${src}_1x2_draw_close`, `${src}_1x2_away_close`);
      if (t !== undefined) mkt[src] = t;
      const o = two(`${src}_over25_close`, `${src}_under25_close`);
      if (o !== undefined) ou[src] = o;
    }
    const a = runs.a_neutral[i];
    const b = runs.b_seeded[i];
    const c = runs.c_backfill[i];
    if (a === undefined || b === undefined || c === undefined) return;
    joined.push({
      rec: { a_neutral: a, b_seeded: b, c_backfill: c },
      key: `${s.key}|${m.home}|${m.away}`,
      outcome: a.outcome,
      mkt,
      ou,
      datesDiffer: differ,
    });
  });
  joinInfo[s.key] = {
    openfootballMatches: cur.matches.length,
    oddsFileRows: [...byPair.keys()].length,
    joined: matched,
    joinRate: round(matched / cur.matches.length, 4),
    duplicatePairsInOddsFile: dup.size,
    dateMismatches: datesDiffer,
    unmatched: missing.slice(0, 10),
  };
}

// ------------------------------------------------------------------ helpers

function marketProbs(o: [number, number, number], method: 'prop' | 'power'): Probs3 {
  const p = method === 'prop' ? proportional(o) : power(o);
  return normalise3([p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
}

const iv = (i: Interval): number[] => [round(i.value, 4), round(i.lo, 4), round(i.hi, 4)];

interface Row {
  key: string;
  model: Probs3;
  market: Probs3;
  o: 0 | 1 | 2;
  modelOdds: [number, number, number];
}

function compare(rows: readonly Row[]): unknown {
  const n = rows.length;
  const ms = (g: (p: Probs3, o: 0 | 1 | 2) => number, who: 'model' | 'market'): number[] =>
    rows.map((r) => g(who === 'model' ? r.model : r.market, r.o));
  const out: Record<string, unknown> = { n };
  for (const [name, g] of [
    ['logLoss', logLoss3],
    ['brier', brier3],
    ['rps', rps3],
  ] as const) {
    const a = ms(g, 'model');
    const b = ms(g, 'market');
    const rel = bootstrap(
      n,
      (idx) => mean(idx.map((i) => a[i] ?? 0)) / mean(idx.map((i) => b[i] ?? 0)) - 1,
      31,
    );
    const diff = bootstrap(n, (idx) => mean(idx.map((i) => (a[i] ?? 0) - (b[i] ?? 0))), 32);
    out[name] = {
      model: round(mean(a), 4),
      market: round(mean(b), 4),
      relativeDiffModelVsMarket: iv(rel),
      absoluteDiff: iv(diff),
    };
  }
  return out;
}

/** Calibration of the disagreement: does (model - market) predict (outcome - market)? */
function edgeTest(rows: readonly Row[]): unknown {
  const n = rows.length;
  const d: number[][] = rows.map((r) =>
    [0, 1, 2].map((k) => (r.model[k as 0 | 1 | 2] ?? 0) - (r.market[k as 0 | 1 | 2] ?? 0)),
  );
  const e: number[][] = rows.map((r) =>
    [0, 1, 2].map((k) => (r.o === k ? 1 : 0) - (r.market[k as 0 | 1 | 2] ?? 0)),
  );
  const slope = (idx: readonly number[]): number => {
    let sxy = 0;
    let sxx = 0;
    for (const i of idx) {
      for (let k = 0; k < 3; k++) {
        const x = d[i]?.[k] ?? 0;
        const y = e[i]?.[k] ?? 0;
        sxy += x * y;
        sxx += x * x;
      }
    }
    return sxy / sxx;
  };
  const edges = [-1, -0.06, -0.03, -0.01, 0.01, 0.03, 0.06, 1];
  const bins = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const lo = edges[b] ?? 0;
    const hi = edges[b + 1] ?? 0;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const x = d[i]?.[k] ?? 0;
        if (x >= lo && x < hi) {
          xs.push(x);
          ys.push(e[i]?.[k] ?? 0);
        }
      }
    }
    bins.push({
      range: `[${lo === -1 ? '-inf' : lo}, ${hi === 1 ? 'inf' : hi})`,
      n: xs.length,
      meanModelMinusMarket: xs.length ? round(mean(xs), 4) : null,
      meanOutcomeMinusMarket: xs.length ? round(mean(ys), 4) : null,
    });
  }
  // Log-loss of a blend w * model + (1 - w) * market.
  const blend = [];
  for (let w = 0; w <= 10; w++) {
    const wt = w / 10;
    const ll = rows.map((r) =>
      logLoss3(
        normalise3(
          [0, 1, 2].map(
            (k) => wt * (r.model[k as 0 | 1 | 2] ?? 0) + (1 - wt) * (r.market[k as 0 | 1 | 2] ?? 0),
          ) as unknown as Probs3,
        ),
        r.o,
      ),
    );
    blend.push({ weightOnModel: wt, logLoss: round(mean(ll), 4) });
  }
  // A customer who knows the market line takes our price when it beats the market's fair price by x.
  const exploit = [0, 0.02, 0.05, 0.1].map((x) => {
    const profits: number[] = [];
    for (const r of rows) {
      for (let k = 0; k < 3; k++) {
        const fair = 1 / (r.market[k as 0 | 1 | 2] ?? 1);
        const ours = r.modelOdds[k as 0 | 1 | 2];
        if (ours >= fair * (1 + x)) profits.push((r.o === k ? ours : 0) - 1);
      }
    }
    const b = bootstrap(profits.length, (idx) => mean(idx.map((i) => profits[i] ?? 0)), 60);
    return { thresholdAboveMarketFair: x, bets: profits.length, roi: iv(b) };
  });
  return {
    n,
    slopeOfOutcomeOnDisagreement: iv(bootstrap(n, slope, 33)),
    note: 'slope 1 = the model disagreement is fully informative, 0 = no information beyond the market, <0 = noise that costs',
    bins,
    blend,
    customerOnlyTakesOurPriceWhenBeatingMarketFair: exploit,
  };
}

// ------------------------------------------------------------------ run

const result: Record<string, unknown> = {
  join: joinInfo,
  source:
    'AnishKhetani/premier-league-data results_with_odds.csv (football-data.co.uk closing odds)',
};
const table: Record<string, unknown> = {};

for (const src of SOURCES) {
  for (const method of ['prop', 'power'] as const) {
    for (const cond of CONDS) {
      const rows: Row[] = [];
      for (const j of joined) {
        const t = j.mkt[src];
        if (t === undefined) continue;
        const rec = j.rec[cond];
        rows.push({
          key: j.key,
          model: rec.p,
          market: marketProbs(t, method),
          o: j.outcome,
          modelOdds: rec.odds1x2,
        });
      }
      const key = `${src}|${method}|${cond}`;
      const perSeason: Record<string, unknown> = {};
      for (const s of SEASONS) {
        const sub = rows.filter((r) => r.key.startsWith(s.key));
        perSeason[s.key] = compare(sub);
      }
      table[key] = {
        overall: compare(rows),
        perSeason,
        ...(method === 'prop' ? { edge: edgeTest(rows) } : {}),
      };
    }
  }
}
result.vsMarket = table;

// Over / under 2.5
const ouTable: Record<string, unknown> = {};
for (const src of SOURCES) {
  for (const method of ['prop', 'power'] as const) {
    for (const cond of CONDS) {
      const mk: number[] = [];
      const md: number[] = [];
      const hit: boolean[] = [];
      for (const j of joined) {
        const t = j.ou[src];
        const r = j.rec[cond];
        if (t === undefined || r.over25 === null) continue;
        const pm = method === 'prop' ? proportional(t) : power(t);
        mk.push(pm[0] ?? 0);
        md.push(r.over25);
        hit.push(r.hg + r.ag > 2.5);
      }
      const ll = (p: number[]): number => mean(p.map((x, i) => logLoss2(x, hit[i] ?? false)));
      const br = (p: number[]): number => mean(p.map((x, i) => brier2(x, hit[i] ?? false)));
      const a = md.map((x, i) => logLoss2(x, hit[i] ?? false));
      const b = mk.map((x, i) => logLoss2(x, hit[i] ?? false));
      ouTable[`${src}|${method}|${cond}`] = {
        n: hit.length,
        logLossModel: round(ll(md)),
        logLossMarket: round(ll(mk)),
        relativeDiff: iv(
          bootstrap(
            hit.length,
            (idx) => mean(idx.map((i) => a[i] ?? 0)) / mean(idx.map((i) => b[i] ?? 0)) - 1,
            34,
          ),
        ),
        brierModel: round(br(md)),
        brierMarket: round(br(mk)),
        meanPredictedOverModel: round(mean(md)),
        meanPredictedOverMarket: round(mean(mk)),
        observedOver: round(mean(hit.map((h) => (h ? 1 : 0)))),
      };
    }
  }
}
result.overUnder25 = ouTable;

// Margins
const overrounds: Record<string, unknown> = {};
for (const src of SOURCES) {
  const v = joined
    .map((j) => j.mkt[src])
    .filter((x): x is [number, number, number] => x !== undefined);
  overrounds[src] = {
    n: v.length,
    meanOverround1x2: round(mean(v.map((t) => t.reduce((a, o) => a + 1 / o, 0) - 1)), 4),
  };
}
overrounds.ourModel1x2 = {
  n: joined.length,
  meanOverround1x2: round(
    mean(joined.map((j) => j.rec.c_backfill.odds1x2.reduce((a, o) => a + 1 / o, 0) - 1)),
    4,
  ),
};
result.overrounds = overrounds;

writeJson(outPath, result);
out(JSON.stringify(joinInfo));
for (const k of Object.keys(table)) {
  if (!k.includes('|prop|')) continue;
  const o = (
    table[k] as {
      overall: {
        n: number;
        logLoss: { model: number; market: number; relativeDiffModelVsMarket: number[] };
        rps: { model: number; market: number };
      };
    }
  ).overall;
  out(
    `${k.padEnd(28)} n=${o.n} LL model ${o.logLoss.model} market ${o.logLoss.market} rel ${JSON.stringify(o.logLoss.relativeDiffModelVsMarket)} RPS ${o.rps.model} v ${o.rps.market}`,
  );
}

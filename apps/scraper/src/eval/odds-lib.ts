import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { CATALOG_TEAMS } from '../../../../packages/db/src/seed/catalog';

/**
 * Shared helpers of the odds evaluation (docs/scraper-evaluation/03-odds-accuracy.md).
 * Measurement only: nothing here is used by production code.
 */

export type Ratings = Record<string, number>;
export type Outcome = 0 | 1 | 2; // home win, draw, away win

export function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
}

// ---------------------------------------------------------------- random, statistics

/** Deterministic PRNG (mulberry32) so every bootstrap interval is reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export interface Interval {
  n: number;
  value: number;
  lo: number;
  hi: number;
}

/** Percentile bootstrap (2000 resamples) of a statistic of the row indices. */
export function bootstrap(
  n: number,
  statistic: (indices: readonly number[]) => number,
  seed = 12345,
  reps = 2000,
): Interval {
  const all = Array.from({ length: n }, (_, i) => i);
  const value = statistic(all);
  if (n < 2) return { n, value, lo: Number.NaN, hi: Number.NaN };
  const rand = rng(seed);
  const draws: number[] = [];
  const idx = new Array<number>(n);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rand() * n);
    draws.push(statistic(idx));
  }
  draws.sort((a, b) => a - b);
  return {
    n,
    value,
    lo: draws[Math.floor(0.025 * reps)] ?? Number.NaN,
    hi: draws[Math.min(reps - 1, Math.floor(0.975 * reps))] ?? Number.NaN,
  };
}

export function bootMean(values: readonly number[], seed = 12345): Interval {
  return bootstrap(values.length, (idx) => mean(idx.map((i) => values[i] ?? 0)), seed);
}

/** Wilson score interval of a binomial proportion. */
export function wilson(k: number, n: number): { lo: number; hi: number } {
  if (n === 0) return { lo: Number.NaN, hi: Number.NaN };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: (c - h) / d, hi: (c + h) / d };
}

export function round(x: number, digits = 4): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function fmtInterval(i: Interval, digits = 4): string {
  return `${round(i.value, digits)} [${round(i.lo, digits)}, ${round(i.hi, digits)}]`;
}

// ---------------------------------------------------------------- scoring rules

export type Probs3 = readonly [number, number, number];

const EPS = 1e-12;

export function brier3(p: Probs3, o: Outcome): number {
  let s = 0;
  for (let k = 0; k < 3; k++) s += ((p[k] ?? 0) - (k === o ? 1 : 0)) ** 2;
  return s;
}

export function logLoss3(p: Probs3, o: Outcome): number {
  return -Math.log(Math.max(EPS, p[o] ?? 0));
}

/** Ranked probability score over the ordered outcomes home, draw, away. */
export function rps3(p: Probs3, o: Outcome): number {
  const c1 = p[0] - (o === 0 ? 1 : 0);
  const c2 = p[0] + p[1] - (o <= 1 ? 1 : 0);
  return (c1 * c1 + c2 * c2) / 2;
}

export function brier2(p: number, y: boolean): number {
  return (p - (y ? 1 : 0)) ** 2;
}

export function logLoss2(p: number, y: boolean): number {
  return -Math.log(Math.max(EPS, y ? p : 1 - p));
}

export function outcomeOf(hg: number, ag: number): Outcome {
  return hg > ag ? 0 : hg === ag ? 1 : 2;
}

export function normalise3(p: Probs3): Probs3 {
  const s = p[0] + p[1] + p[2];
  return [p[0] / s, p[1] / s, p[2] / s];
}

/** Proportional (basic) margin removal of decimal odds. */
export function proportional(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((x) => x / s);
}

/** Power method: p_i = (1/o_i)^k with k >= 1 solved so that the sum is 1. */
export function power(odds: readonly number[]): number[] {
  const inv = odds.map((o) => 1 / o);
  const sum = (k: number): number => inv.reduce((a, x) => a + x ** k, 0);
  if (sum(1) <= 1) return proportional(odds);
  let lo = 1;
  let hi = 2;
  while (sum(hi) > 1 && hi < 64) hi *= 2;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (sum(mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return inv.map((x) => x ** k);
}

// ---------------------------------------------------------------- reliability

export interface ReliabilityBin {
  bin: string;
  n: number;
  meanPredicted: number | null;
  observed: number | null;
  deviationPp: number | null;
}

export interface Reliability {
  n: number;
  bins: ReliabilityBin[];
  /** Expected calibration error, in percentage points, weighted by bin counts. */
  eceInterval: Interval;
  /** Mean predicted minus observed frequency, percentage points. */
  biasPp: Interval;
  observedRate: number;
  meanPredicted: number;
  /** Largest |deviation| over bins with n >= 30, pp (null if no such bin). */
  maxDeviationPpN30: number | null;
}

/** Reliability table with equal-width probability deciles. */
export function reliability(pred: readonly number[], hit: readonly boolean[]): Reliability {
  const n = pred.length;
  const ecePoint = (idx: readonly number[]): number => {
    const cnt = new Array<number>(10).fill(0);
    const sp = new Array<number>(10).fill(0);
    const sy = new Array<number>(10).fill(0);
    for (const i of idx) {
      const p = pred[i] ?? 0;
      const b = Math.min(9, Math.floor(p * 10));
      cnt[b] = (cnt[b] ?? 0) + 1;
      sp[b] = (sp[b] ?? 0) + p;
      sy[b] = (sy[b] ?? 0) + (hit[i] ? 1 : 0);
    }
    let e = 0;
    for (let b = 0; b < 10; b++) {
      const c = cnt[b] ?? 0;
      if (c > 0) e += Math.abs((sp[b] ?? 0) / c - (sy[b] ?? 0) / c) * c;
    }
    return (100 * e) / Math.max(1, idx.length);
  };
  const all = Array.from({ length: n }, (_, i) => i);
  const bins: ReliabilityBin[] = [];
  let maxDev: number | null = null;
  for (let b = 0; b < 10; b++) {
    const idx = all.filter((i) => Math.min(9, Math.floor((pred[i] ?? 0) * 10)) === b);
    const label = `${b * 10}-${b * 10 + 10}%`;
    if (idx.length === 0) {
      bins.push({ bin: label, n: 0, meanPredicted: null, observed: null, deviationPp: null });
      continue;
    }
    const mp = mean(idx.map((i) => pred[i] ?? 0));
    const ob = mean(idx.map((i) => (hit[i] ? 1 : 0)));
    const dev = 100 * (mp - ob);
    if (idx.length >= 30) maxDev = Math.max(maxDev ?? 0, Math.abs(dev));
    bins.push({
      bin: label,
      n: idx.length,
      meanPredicted: round(mp, 4),
      observed: round(ob, 4),
      deviationPp: round(dev, 2),
    });
  }
  const ece = bootstrap(n, ecePoint, 777);
  const bias = bootstrap(
    n,
    (idx) => 100 * (mean(idx.map((i) => pred[i] ?? 0)) - mean(idx.map((i) => (hit[i] ? 1 : 0)))),
    778,
  );
  return {
    n,
    bins,
    eceInterval: ece,
    biasPp: bias,
    observedRate: mean(hit.map((h) => (h ? 1 : 0))),
    meanPredicted: mean(pred),
    maxDeviationPpN30: maxDev === null ? null : round(maxDev, 2),
  };
}

// ---------------------------------------------------------------- results data

export interface MatchRow {
  date: string;
  time: string;
  round: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  /** True when the scraper's openfootball adapter would read this score (a proper score object). */
  visible: boolean;
  /** True when the score is inferred from a bare `[0, 0]` entry (see the report). */
  inferred: boolean;
}

const scoreObject = z.object({
  ft: z.tuple([z.number().int(), z.number().int()]).optional(),
  ht: z.tuple([z.number().int(), z.number().int()]).optional(),
});

const matchSchema = z.object({
  round: z.string().optional(),
  date: z.string(),
  time: z.string().optional(),
  team1: z.string(),
  team2: z.string(),
  score: z.union([scoreObject, z.array(z.number().int())]).optional(),
});

export interface LoadedLeague {
  matches: MatchRow[];
  /** Entries whose score is a bare list (the adapter rejects them: "score must be an object"). */
  bareLists: number;
  bareNotZeroZero: number;
  unplayed: number;
  total: number;
}

/**
 * Reads an openfootball league file. A proper `{ft: [h, a]}` score is a
 * result the scraper accepts. A bare `[0, 0]` list is rejected by the scraper
 * (packages/scraper/src/adapters/openfootball.ts `bad_score`); here it counts
 * as a goalless draw (inferred) when its date is not after the newest proper
 * result of the file, and as unplayed otherwise. The PL files are checked
 * against two independent sources in odds-backtest.ts.
 */
export function loadOpenfootball(path: string): LoadedLeague {
  const raw = z.object({ matches: z.array(matchSchema) }).parse(readJson(path));
  let lastProper = '';
  for (const m of raw.matches) {
    if (!Array.isArray(m.score) && m.score?.ft !== undefined && m.date > lastProper) {
      lastProper = m.date;
    }
  }
  const matches: MatchRow[] = [];
  let bareLists = 0;
  let bareNotZeroZero = 0;
  let unplayed = 0;
  for (const m of raw.matches) {
    const base = {
      date: m.date,
      time: m.time ?? '00:00',
      round: m.round ?? '',
      home: m.team1,
      away: m.team2,
    };
    if (Array.isArray(m.score)) {
      bareLists++;
      const zero = m.score.length === 2 && m.score[0] === 0 && m.score[1] === 0;
      if (!zero) bareNotZeroZero++;
      if (zero && m.date <= lastProper) {
        matches.push({ ...base, hg: 0, ag: 0, visible: false, inferred: true });
      } else unplayed++;
    } else if (m.score?.ft !== undefined) {
      matches.push({
        ...base,
        hg: m.score.ft[0],
        ag: m.score.ft[1],
        visible: true,
        inferred: false,
      });
    } else unplayed++;
  }
  matches.sort((a, b) =>
    a.date + a.time < b.date + b.time ? -1 : a.date + a.time > b.date + b.time ? 1 : 0,
  );
  return { matches, bareLists, bareNotZeroZero, unplayed, total: raw.matches.length };
}

// ---------------------------------------------------------------- team names

/** openfootball name to catalogue short name, for the clubs the catalogue has. */
const CATALOG_NAME: Readonly<Record<string, string>> = {
  // Premier League
  'AFC Bournemouth': 'Bournemouth',
  'Arsenal FC': 'Arsenal',
  'Aston Villa FC': 'Aston Villa',
  'Brentford FC': 'Brentford',
  'Brighton & Hove Albion FC': 'Brighton',
  'Burnley FC': 'Burnley',
  'Chelsea FC': 'Chelsea',
  'Crystal Palace FC': 'Crystal Palace',
  'Everton FC': 'Everton',
  'Fulham FC': 'Fulham',
  'Leeds United FC': 'Leeds',
  'Liverpool FC': 'Liverpool',
  'Manchester City FC': 'Man City',
  'Manchester United FC': 'Man Utd',
  'Newcastle United FC': 'Newcastle',
  'Nottingham Forest FC': "Nott'm Forest",
  'Sunderland AFC': 'Sunderland',
  'Tottenham Hotspur FC': 'Tottenham',
  'West Ham United FC': 'West Ham',
  'Wolverhampton Wanderers FC': 'Wolves',
  // La Liga
  'Athletic Club': 'Athletic Club',
  'CA Osasuna': 'Osasuna',
  'Club Atlético de Madrid': 'Atletico Madrid',
  'FC Barcelona': 'Barcelona',
  'Getafe CF': 'Getafe',
  'Girona FC': 'Girona',
  'RC Celta de Vigo': 'Celta Vigo',
  'Rayo Vallecano de Madrid': 'Rayo Vallecano',
  'Real Betis Balompié': 'Real Betis',
  'Real Madrid CF': 'Real Madrid',
  'Real Sociedad de Fútbol': 'Real Sociedad',
  'Sevilla FC': 'Sevilla',
  'Valencia CF': 'Valencia',
  'Villarreal CF': 'Villarreal',
  // Serie A
  'AC Milan': 'AC Milan',
  'ACF Fiorentina': 'Fiorentina',
  'AS Roma': 'Roma',
  'Atalanta BC': 'Atalanta',
  'Bologna FC 1909': 'Bologna',
  'Como 1907': 'Como',
  'FC Internazionale Milano': 'Inter',
  'Genoa CFC': 'Genoa',
  'Juventus FC': 'Juventus',
  'SS Lazio': 'Lazio',
  'SSC Napoli': 'Napoli',
  'Torino FC': 'Torino',
  'Udinese Calcio': 'Udinese',
  // Bundesliga
  'Bayer 04 Leverkusen': 'Leverkusen',
  'Borussia Dortmund': 'Dortmund',
  'Borussia Mönchengladbach': 'Gladbach',
  'Eintracht Frankfurt': 'Frankfurt',
  'FC Bayern München': 'Bayern',
  'RB Leipzig': 'RB Leipzig',
  'SC Freiburg': 'Freiburg',
  'SV Werder Bremen': 'Werder Bremen',
  'TSG 1899 Hoffenheim': 'Hoffenheim',
  'VfB Stuttgart': 'Stuttgart',
  'VfL Wolfsburg': 'Wolfsburg',
  '1. FSV Mainz 05': 'Mainz',
  '1. FC Union Berlin': 'Union Berlin',
  // Ligue 1
  'AS Monaco FC': 'Monaco',
  'Lille OSC': 'Lille',
  'OGC Nice': 'Nice',
  'Olympique Lyonnais': 'Lyon',
  'Olympique de Marseille': 'Marseille',
  'Paris Saint-Germain FC': 'PSG',
  'RC Strasbourg Alsace': 'Strasbourg',
  'Racing Club de Lens': 'Lens',
  'Stade Brestois 29': 'Brest',
  'Stade Rennais FC 1901': 'Rennes',
  'Toulouse FC': 'Toulouse',
  'FC Nantes': 'Nantes',
  'AJ Auxerre': 'Auxerre',
};

const CATALOG_RATINGS: ReadonlyMap<string, Ratings> = new Map(
  CATALOG_TEAMS.filter((t) => t.sport === 'football').map((t) => [t.shortName, { ...t.ratings }]),
);

/** The seeded ratings of an openfootball team name, or null when the catalogue has no such club. */
export function seededRatings(name: string): Ratings | null {
  const short = CATALOG_NAME[name];
  if (short === undefined) return null;
  const r = CATALOG_RATINGS.get(short);
  return r === undefined ? null : { ...r };
}

/** Short names used by the football-data.co.uk based odds file, keyed by openfootball name. */
export const FOOTBALL_DATA_NAME: Readonly<Record<string, string>> = {
  'AFC Bournemouth': 'Bournemouth',
  'Arsenal FC': 'Arsenal',
  'Aston Villa FC': 'Aston Villa',
  'Brentford FC': 'Brentford',
  'Brighton & Hove Albion FC': 'Brighton',
  'Burnley FC': 'Burnley',
  'Chelsea FC': 'Chelsea',
  'Crystal Palace FC': 'Crystal Palace',
  'Everton FC': 'Everton',
  'Fulham FC': 'Fulham',
  'Ipswich Town FC': 'Ipswich',
  'Leeds United FC': 'Leeds',
  'Leicester City FC': 'Leicester',
  'Liverpool FC': 'Liverpool',
  'Manchester City FC': 'Man City',
  'Manchester United FC': 'Man United',
  'Newcastle United FC': 'Newcastle',
  'Nottingham Forest FC': "Nott'm Forest",
  'Southampton FC': 'Southampton',
  'Sunderland AFC': 'Sunderland',
  'Tottenham Hotspur FC': 'Tottenham',
  'West Ham United FC': 'West Ham',
  'Wolverhampton Wanderers FC': 'Wolves',
};

// ---------------------------------------------------------------- csv

/** Minimal CSV reader (quotes, embedded commas). Returns rows keyed by header. */
export function readCsv(path: string): Array<Record<string, string>> {
  return parseCsv(readFileSync(path, 'utf8'));
}

/** The same reader over text already in memory. A leading BOM is dropped (football-data files have one). */
export function parseCsv(content: string): Array<Record<string, string>> {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function num(value: string | undefined): number | null {
  if (value === undefined || value === '' || value === 'nan' || value === 'NaN') return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

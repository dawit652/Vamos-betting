import { readFileSync } from 'node:fs';
import {
  matchStrengths,
  priceFixture,
  priceFootball,
  type FeedMarket,
  expectedGoals,
} from '@vamos/feed';
import { checkMarkets, MARKET_OUTCOME_COVER } from '@vamos/scraper';
import { marketKey, selectionsFor } from '@vamos/core';
import { loadOpenfootball, out, round, seededRatings, writeJson, type Ratings } from './odds-lib';

/**
 * Price integrity of what priceFixture publishes, checked with the production
 * gate (checkMarkets, rule O2) and with independent checks.
 *
 *   pnpm --filter @vamos/scraper-app exec tsx src/eval/odds-integrity.ts <data-dir> <out.json>
 *
 * <data-dir>/of/2026-27_en.1.json is the real 2026-27 Premier League fixture list.
 *
 * Independent checks use INTERVAL arithmetic: a published price o (integer
 * milli) can only come from a probability p in a known interval, because the
 * price is odds = floor(1000 / (p (1 + m)) to a hundredth, 1.01 floor,
 * fallback to thousandths for heavy favourites, cap 1000. A violation means no
 * probability vector at all could have produced the book.
 */

const [dataDir, outPath] = process.argv.slice(2);
if (dataDir === undefined || outPath === undefined) {
  throw new Error('usage: odds-integrity.ts <data-dir> <out.json>');
}

const EPS = 1e-9;
const DECLARED_BPS: Record<string, number> = { cs: 1500 };
const declared = (type: string): number => (DECLARED_BPS[type] ?? 600) / 10_000;

type Interval2 = [number, number];

/** The probabilities that can have produced a published price (see header). */
function probInterval(oddsMilli: number, margin: number): Interval2 {
  const m = 1 + margin;
  if (oddsMilli >= 1_000_000) return [0, 1000 / (1_000_000 * m)];
  if (oddsMilli === 1010) return [1000 / (1020 * m), 1000 / 1010];
  if (oddsMilli < 1010) {
    // Fallback of priceProbability: for p above 1/1.01 the 6% margin pushes the raw price below
    // 1.001, so the price is the 1.001 floor; any p in (1/1.01, 1/1.001] ends up here.
    return [1000 / 1010, 1000 / oddsMilli];
  }
  return [1000 / ((oddsMilli + 10) * m), 1000 / (oddsMilli * m)];
}

interface Inputs {
  label: string;
  home: Ratings | null;
  away: Ratings | null;
}

interface Violation {
  check: string;
  inputs: string;
  detail: string;
}

class Tally {
  readonly counts = new Map<string, number>();
  readonly examples = new Map<string, Violation[]>();
  add(v: Violation): void {
    this.counts.set(v.check, (this.counts.get(v.check) ?? 0) + 1);
    const list = this.examples.get(v.check) ?? [];
    if (list.length < 6) list.push(v);
    this.examples.set(v.check, list);
  }
}

function describe(i: Inputs): string {
  const r = (x: Ratings | null): string => (x === null ? 'null' : JSON.stringify(x));
  return `${i.label} home=${r(i.home)} away=${r(i.away)}`;
}

function selectionMap(m: FeedMarket): Map<string, number> {
  return new Map(m.selections.map((s) => [s.code, s.oddsMilli]));
}

/** Quantile of a numeric array. */
function q(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] ?? Number.NaN;
}

interface Stats {
  dev: Record<string, number[]>; // market key type -> overround deviation (pp) vs declared
  missing: Record<string, number>;
  floorOrFallback: number;
  atCap: number;
  selections: number;
  minOverroundPerCover: Record<string, number>;
  nonHundredth: number;
  books: number;
  gateFailBooks: number;
  anyMarginOffBooks: number;
}

function newStats(): Stats {
  return {
    dev: {},
    missing: {},
    floorOrFallback: 0,
    atCap: 0,
    selections: 0,
    minOverroundPerCover: {},
    nonHundredth: 0,
    books: 0,
    gateFailBooks: 0,
    anyMarginOffBooks: 0,
  };
}

const ALL_KEYS = [
  '1x2',
  'dc',
  'ou:0.5',
  'ou:1.5',
  'ou:2.5',
  'ou:3.5',
  'ou:4.5',
  'btts',
  'dnb',
  'ht_1x2',
  'cs',
];

function checkBook(
  inputs: Inputs,
  markets: readonly FeedMarket[],
  tally: Tally,
  stats: Stats,
): void {
  stats.books++;
  const where = describe(inputs);
  const byKey = new Map<string, FeedMarket>();
  for (const m of markets) byKey.set(marketKey(m.type, m.line), m);
  for (const k of ALL_KEYS) if (!byKey.has(k)) stats.missing[k] = (stats.missing[k] ?? 0) + 1;

  // Production gate O2.
  const gate = checkMarkets(markets);
  if (!gate.ok) {
    stats.gateFailBooks++;
    for (const i of gate.issues) {
      tally.add({
        check: `gate_O2:${i.code}`,
        inputs: where,
        detail: `${i.market ?? ''} ${i.detail}`,
      });
    }
  }

  const iv = new Map<string, Map<string, Interval2>>();
  for (const [key, m] of byKey) {
    const margin = declared(m.type);
    const cover = MARKET_OUTCOME_COVER[m.type];
    const sel = selectionMap(m);
    // selection set and price bounds
    const expected = selectionsFor(m.type);
    if (expected.length !== sel.size || !expected.every((c) => sel.has(c))) {
      tally.add({ check: 'selection_set', inputs: where, detail: key });
    }
    let sum = 0;
    const intervals = new Map<string, Interval2>();
    for (const [code, o] of sel) {
      stats.selections++;
      if (!Number.isInteger(o) || o < 1001 || o > 1_000_000) {
        tally.add({ check: 'odds_bounds', inputs: where, detail: `${key} ${code} ${o}` });
      }
      if (o <= 1010) stats.floorOrFallback++;
      if (o >= 1_000_000) stats.atCap++;
      if (o > 1010 && o < 1_000_000 && o % 10 !== 0) {
        stats.nonHundredth++;
        tally.add({ check: 'not_whole_hundredth', inputs: where, detail: `${key} ${code} ${o}` });
      }
      sum += 1000 / o;
      intervals.set(code, probInterval(o, margin));
    }
    iv.set(key, intervals);
    // overround versus the declared margin
    const per = sum / cover;
    const devPp = 100 * (per - (1 + margin));
    (stats.dev[m.type] ??= []).push(devPp);
    stats.minOverroundPerCover[m.type] = Math.min(
      stats.minOverroundPerCover[m.type] ?? Infinity,
      per,
    );
    if (per < 1 - EPS) {
      tally.add({
        check: 'sure_win_book',
        inputs: where,
        detail: `${key} overround ${per.toFixed(5)}`,
      });
    }
    if (Math.abs(devPp) > 0.5) {
      tally.add({
        check: `margin_off_by_over_0.5pp:${m.type}`,
        inputs: where,
        detail: `${key} overround ${(per - 1).toFixed(4)} vs declared ${margin} (${devPp.toFixed(2)} pp)`,
      });
    }
    // probabilities must be able to sum to `cover`
    let lo = 0;
    let hi = 0;
    for (const [a, b] of intervals.values()) {
      lo += a;
      hi += b;
    }
    if (lo > cover + EPS || hi < cover - EPS) {
      tally.add({
        check: 'probability_sum',
        inputs: where,
        detail: `${key} possible sum [${lo.toFixed(4)}, ${hi.toFixed(4)}] cannot reach ${cover}`,
      });
    }
  }

  const get = (key: string, code: string): Interval2 | undefined => iv.get(key)?.get(code);
  const overlap = (a: Interval2, b: Interval2): boolean => a[0] <= b[1] + EPS && b[0] <= a[1] + EPS;
  const add2 = (a: Interval2, b: Interval2): Interval2 => [a[0] + b[0], a[1] + b[1]];

  // double chance equals the right combination of 1X2
  const p1 = get('1x2', '1');
  const px = get('1x2', 'X');
  const p2 = get('1x2', '2');
  if (p1 && px && p2) {
    const pairs: Array<[string, Interval2 | undefined]> = [
      ['1X', get('dc', '1X')],
      ['12', get('dc', '12')],
      ['X2', get('dc', 'X2')],
    ];
    const want: Record<string, Interval2> = {
      '1X': add2(p1, px),
      '12': add2(p1, p2),
      X2: add2(px, p2),
    };
    for (const [code, got] of pairs) {
      const w = want[code];
      if (got && w && !overlap(got, w)) {
        tally.add({
          check: 'dc_vs_1x2',
          inputs: where,
          detail: `${code} dc ${JSON.stringify(got.map((x) => round(x, 4)))} vs 1x2 ${JSON.stringify(w.map((x) => round(x, 4)))}`,
        });
      }
    }
    // draw no bet = p1 / (p1 + p2)
    const d1 = get('dnb', '1');
    if (d1) {
      const w: Interval2 = [p1[0] / (p1[0] + p2[1]), p1[1] / (p1[1] + p2[0])];
      if (!overlap(d1, w))
        tally.add({
          check: 'dnb_vs_1x2',
          inputs: where,
          detail: `dnb1 ${JSON.stringify(d1.map((x) => round(x, 4)))} vs ${JSON.stringify(w.map((x) => round(x, 4)))}`,
        });
    }
    // correct score grid plus other brackets every 1X2 outcome
    const cs = iv.get('cs');
    if (cs) {
      const classes: Record<string, Interval2> = { '1': [0, 0], X: [0, 0], '2': [0, 0] };
      for (const [code, v] of cs) {
        if (code === 'other') continue;
        const [h, a] = code.split('-').map(Number) as [number, number];
        const k = h > a ? '1' : h === a ? 'X' : '2';
        classes[k] = add2(classes[k] as Interval2, v);
      }
      const other = cs.get('other') ?? [0, 0];
      const outcome: Record<string, Interval2> = { '1': p1, X: px, '2': p2 };
      for (const k of ['1', 'X', '2']) {
        const c = classes[k] as Interval2;
        const o = outcome[k] as Interval2;
        // sum of cells <= P(k) <= sum of cells + other
        if (c[0] > o[1] + EPS || o[0] > c[1] + other[1] + EPS) {
          tally.add({
            check: 'cs_vs_1x2',
            inputs: where,
            detail: `outcome ${k}: cs cells ${JSON.stringify(c.map((x) => round(x, 4)))} (+other<=${round(other[1], 4)}) vs 1x2 ${JSON.stringify(o.map((x) => round(x, 4)))}`,
          });
        }
      }
      // both teams to score "no": cells with a zero, plus part of other
      const no = get('btts', 'no');
      if (no) {
        let cells: Interval2 = [0, 0];
        for (const [code, v] of cs) {
          if (code === 'other') continue;
          const [h, a] = code.split('-').map(Number) as [number, number];
          if (h === 0 || a === 0) cells = add2(cells, v);
        }
        if (cells[0] > no[1] + EPS || no[0] > cells[1] + other[1] + EPS) {
          tally.add({
            check: 'cs_vs_btts',
            inputs: where,
            detail: `btts no ${JSON.stringify(no.map((x) => round(x, 4)))} vs cs ${JSON.stringify(cells.map((x) => round(x, 4)))}`,
          });
        }
      }
      // under lines: cells with h + a < line are fully under
      for (const line of ['0.5', '1.5', '2.5', '3.5', '4.5']) {
        const under = get(`ou:${line}`, 'under');
        if (!under) continue;
        let cells: Interval2 = [0, 0];
        for (const [code, v] of cs) {
          if (code === 'other') continue;
          const [h, a] = code.split('-').map(Number) as [number, number];
          if (h + a < Number(line)) cells = add2(cells, v);
        }
        if (cells[0] > under[1] + EPS) {
          tally.add({
            check: 'cs_vs_ou',
            inputs: where,
            detail: `under ${line} ${JSON.stringify(under.map((x) => round(x, 4)))} below cs cells ${JSON.stringify(cells.map((x) => round(x, 4)))}`,
          });
        }
      }
    }
  }

  // over/under lines monotonic: odds of over rise with the line, odds of under fall
  const lines = ['0.5', '1.5', '2.5', '3.5', '4.5'].filter((l) => byKey.has(`ou:${l}`));
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = selectionMap(byKey.get(`ou:${lines[i]}`) as FeedMarket);
    const b = selectionMap(byKey.get(`ou:${lines[i + 1]}`) as FeedMarket);
    if (
      (a.get('over') ?? 0) > (b.get('over') ?? 0) ||
      (a.get('under') ?? 0) < (b.get('under') ?? 0)
    ) {
      tally.add({
        check: 'ou_not_monotonic',
        inputs: where,
        detail: `${lines[i]} over ${a.get('over')} under ${a.get('under')}; ${lines[i + 1]} over ${b.get('over')} under ${b.get('under')}`,
      });
    }
  }
  // cross-line and cross-market sure wins: a cover of every outcome must cost at least 1
  const inv = (key: string, code: string): number | undefined => {
    const o = byKey.get(key) ? selectionMap(byKey.get(key) as FeedMarket).get(code) : undefined;
    return o === undefined ? undefined : 1000 / o;
  };
  const covers: Array<[string, number | undefined, number | undefined]> = [
    ['dc 1X + 1x2 2', inv('dc', '1X'), inv('1x2', '2')],
    ['dc X2 + 1x2 1', inv('dc', 'X2'), inv('1x2', '1')],
    ['dc 12 + 1x2 X', inv('dc', '12'), inv('1x2', 'X')],
  ];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i; j < lines.length; j++) {
      covers.push([
        `over ${lines[i]} + under ${lines[j]}`,
        inv(`ou:${lines[i]}`, 'over'),
        inv(`ou:${lines[j]}`, 'under'),
      ]);
    }
  }
  for (const [label, x, y] of covers) {
    if (x !== undefined && y !== undefined && x + y < 1 - EPS) {
      tally.add({
        check: 'cross_market_sure_win',
        inputs: where,
        detail: `${label}: implied ${(x + y).toFixed(4)} < 1`,
      });
    }
  }
}

// ------------------------------------------------------------------ 1. rating grid

const AXIS = [0.35, 0.5, 0.7, 0.85, 1, 1.2, 1.6, 2.2, 3];
const gridTally = new Tally();
const gridStats = newStats();
let gridBooks = 0;
let throws = 0;
const missing1x2: string[] = [];
for (const ha of AXIS) {
  for (const hd of AXIS) {
    for (const aa of AXIS) {
      for (const ad of AXIS) {
        const inputs: Inputs = {
          label: 'grid',
          home: { attack: ha, defence: hd },
          away: { attack: aa, defence: ad },
        };
        let markets: FeedMarket[];
        try {
          markets = priceFixture('football', inputs.home, inputs.away);
        } catch (error) {
          throws++;
          gridTally.add({
            check: 'priceFixture_threw',
            inputs: describe(inputs),
            detail: String(error),
          });
          continue;
        }
        gridBooks++;
        if (!markets.some((m) => m.type === '1x2') && missing1x2.length < 5)
          missing1x2.push(describe(inputs));
        checkBook(inputs, markets, gridTally, gridStats);
      }
    }
  }
}

// ------------------------------------------------------------------ 2. named scenarios

const scenarios: Inputs[] = [
  {
    label: 'strongest home v weakest away',
    home: { attack: 3, defence: 0.35 },
    away: { attack: 0.35, defence: 3 },
  },
  {
    label: 'weakest home v strongest away',
    home: { attack: 0.35, defence: 3 },
    away: { attack: 3, defence: 0.35 },
  },
  {
    label: 'equal teams, neutral',
    home: { attack: 1, defence: 1 },
    away: { attack: 1, defence: 1 },
  },
  {
    label: 'equal teams, strong',
    home: { attack: 1.5, defence: 0.7 },
    away: { attack: 1.5, defence: 0.7 },
  },
  {
    label: 'equal teams, weak',
    home: { attack: 0.8, defence: 1.2 },
    away: { attack: 0.8, defence: 1.2 },
  },
  {
    label: 'seeded best v seeded worst PL (Liverpool v Burnley)',
    home: seededRatings('Liverpool FC'),
    away: seededRatings('Burnley FC'),
  },
  {
    label: 'seeded worst v best PL (Burnley v Liverpool)',
    home: seededRatings('Burnley FC'),
    away: seededRatings('Liverpool FC'),
  },
  {
    label: 'Bayern v Mainz (seeded)',
    home: seededRatings('FC Bayern München'),
    away: seededRatings('1. FSV Mainz 05'),
  },
  { label: 'missing both (null)', home: null, away: null },
  { label: 'empty objects', home: {}, away: {} },
];
const scenarioRows: unknown[] = [];
const scenarioTally = new Tally();
for (const s of scenarios) {
  const markets = priceFixture('football', s.home, s.away);
  const strengths = matchStrengths('football', s.home, s.away);
  const one = markets.find((m) => m.type === '1x2');
  const odds = one
    ? Object.fromEntries(one.selections.map((x) => [x.code, x.oddsMilli / 1000]))
    : null;
  const sums = (type: string, line: string | null): number | null => {
    const m = markets.find((x) => x.type === type && x.line === line);
    return m
      ? round(
          m.selections.reduce((a, x) => a + 1000 / x.oddsMilli, 0),
          4,
        )
      : null;
  };
  checkBook(s, markets, scenarioTally, newStats());
  scenarioRows.push({
    scenario: s.label,
    lambdaHome: round(strengths.home, 3),
    lambdaAway: round(strengths.away, 3),
    odds1x2: odds,
    overround1x2: sums('1x2', null),
    marketsOffered: markets.length,
    missingMarkets: ALL_KEYS.filter((k) => !markets.some((m) => marketKey(m.type, m.line) === k)),
    gateO2: checkMarkets(markets).ok,
  });
}

// ------------------------------------------------------------------ 3. missing / extreme / malformed ratings

const weird: Array<[string, unknown, unknown]> = [
  ['attack 0', { attack: 0, defence: 1 }, { attack: 1, defence: 1 }],
  ['attack -2', { attack: -2, defence: 1 }, { attack: 1, defence: 1 }],
  ['attack NaN', { attack: Number.NaN, defence: 1 }, { attack: 1, defence: 1 }],
  ['attack Infinity', { attack: Number.POSITIVE_INFINITY, defence: 1 }, { attack: 1, defence: 1 }],
  ['attack as string "1.5"', { attack: '1.5', defence: 1 }, { attack: 1, defence: 1 }],
  ['attack 100 (out of band)', { attack: 100, defence: 0.01 }, { attack: 0.01, defence: 100 }],
  ['array instead of object', [1, 2], { attack: 1, defence: 1 }],
  ['offence instead of attack', { offence: 1.8, defence: 0.7 }, { attack: 1, defence: 1 }],
  ['missing defence only', { attack: 2 }, { attack: 1, defence: 1 }],
];
const weirdRows = weird.map(([label, h, a]) => {
  try {
    const markets = priceFixture('football', h as Ratings, a as Ratings);
    const s = matchStrengths('football', h as Ratings, a as Ratings);
    const book = new Tally();
    checkBook({ label, home: null, away: null }, markets, book, newStats());
    return {
      case: label,
      threw: false,
      lambdaHome: round(s.home, 3),
      lambdaAway: round(s.away, 3),
      gateO2: checkMarkets(markets).ok,
      markets: markets.length,
      otherViolations: Object.fromEntries(book.counts),
    };
  } catch (error) {
    return { case: label, threw: true, error: String(error) };
  }
});

// ------------------------------------------------------------------ 4. exact mirror symmetry

const LAMBDAS = [0.05, 0.3, 0.7, 1.0, 1.35, 1.8, 2.5, 3.5, 6];
const mirrorMap: Array<[string, string, string]> = [
  ['1x2', '1', '2'],
  ['dc', '1X', 'X2'],
  ['dnb', '1', '2'],
  ['ht_1x2', '1', '2'],
];
let mirrorChecked = 0;
let mirrorBroken = 0;
const mirrorExamples: string[] = [];
for (const x of LAMBDAS) {
  for (const y of LAMBDAS) {
    const a = priceFootball(x, y);
    const b = priceFootball(y, x);
    const A = new Map(a.map((m) => [marketKey(m.type, m.line), selectionMap(m)]));
    const B = new Map(b.map((m) => [marketKey(m.type, m.line), selectionMap(m)]));
    const fail = (what: string): void => {
      mirrorBroken++;
      if (mirrorExamples.length < 8) mirrorExamples.push(`lambda ${x}/${y}: ${what}`);
    };
    for (const k of new Set([...A.keys(), ...B.keys()])) {
      if (!A.has(k) || !B.has(k)) {
        mirrorChecked++;
        fail(`market ${k} offered on one side only`);
      }
    }
    for (const [key, s1, s2] of mirrorMap) {
      const m1 = A.get(key);
      const m2 = B.get(key);
      if (!m1 || !m2) continue;
      mirrorChecked++;
      if (m1.get(s1) !== m2.get(s2) || m1.get(s2) !== m2.get(s1))
        fail(
          `${key} ${s1}/${s2} ${m1.get(s1)}/${m1.get(s2)} vs mirror ${m2.get(s1)}/${m2.get(s2)}`,
        );
    }
    for (const k of ['1x2', 'dc', 'btts', 'ou:2.5']) {
      // symmetric selections: draw, 12, btts, totals
      const m1 = A.get(k);
      const m2 = B.get(k);
      if (!m1 || !m2) continue;
      for (const code of k === '1x2'
        ? ['X']
        : k === 'dc'
          ? ['12']
          : k === 'btts'
            ? ['yes', 'no']
            : ['over', 'under']) {
        mirrorChecked++;
        if (m1.get(code) !== m2.get(code)) fail(`${k} ${code} ${m1.get(code)} vs ${m2.get(code)}`);
      }
    }
    const c1 = A.get('cs');
    const c2 = B.get('cs');
    if (c1 && c2) {
      for (let h = 0; h <= 4; h++) {
        for (let aw = 0; aw <= 4; aw++) {
          mirrorChecked++;
          if (c1.get(`${h}-${aw}`) !== c2.get(`${aw}-${h}`))
            fail(`cs ${h}-${aw} ${c1.get(`${h}-${aw}`)} vs mirror ${c2.get(`${aw}-${h}`)}`);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ 5. home advantage at equal ratings

function fairFrom(m: FeedMarket | undefined): number[] | null {
  if (!m) return null;
  const inv = m.selections.map((s) => 1000 / s.oddsMilli);
  const t = inv.reduce((a, b) => a + b, 0);
  return inv.map((v) => round(v / t, 4));
}
const equal = priceFixture('football', { attack: 1, defence: 1 }, { attack: 1, defence: 1 });
const homeAdvantage = {
  equalRatings1x2Fair: fairFrom(equal.find((m) => m.type === '1x2')),
  lambdaHome: expectedGoals({ attack: 1, defence: 1 }, { attack: 1, defence: 1 }).home,
  lambdaAway: expectedGoals({ attack: 1, defence: 1 }, { attack: 1, defence: 1 }).away,
  note: 'home advantage is the fixed multiplier FOOTBALL_HOME_ADVANTAGE = 1.15 on the home side expected goals; priceFixture offers no way to change it per league or team',
};

// ------------------------------------------------------------------ 6. real 2026-27 Premier League fixtures

const fixtures = loadOpenfootball(`${dataDir}/of/2026-27_en.1.json`);
const fixtureTally = new Tally();
const fixtureStats = newStats();
let fixturesPriced = 0;
let fixturesNeutral = 0;
const unseeded = new Set<string>();
const raw = JSON.parse(readFileSync(`${dataDir}/of/2026-27_en.1.json`, 'utf8')) as {
  matches: Array<{ team1: string; team2: string; date: string }>;
};
for (const m of raw.matches) {
  const h = seededRatings(m.team1);
  const a = seededRatings(m.team2);
  if (h === null) unseeded.add(m.team1);
  if (a === null) unseeded.add(m.team2);
  if (h === null || a === null) fixturesNeutral++;
  const markets = priceFixture('football', h, a);
  fixturesPriced++;
  checkBook(
    { label: `${m.date} ${m.team1} v ${m.team2}`, home: h, away: a },
    markets,
    fixtureTally,
    fixtureStats,
  );
}
const calibratedByO1 = 0; // seeded ratings carry no `matches` and no `manual`: rule O1 treats every seeded club as uncalibrated

// ------------------------------------------------------------------ report

function summarise(stats: Stats, tally: Tally): unknown {
  const dev: Record<string, unknown> = {};
  for (const [type, values] of Object.entries(stats.dev)) {
    dev[type] = {
      n: values.length,
      min: round(Math.min(...values), 3),
      p01: round(q(values, 0.01), 3),
      median: round(q(values, 0.5), 3),
      p99: round(q(values, 0.99), 3),
      max: round(Math.max(...values), 3),
      shareOutsidePlusMinus0_5pp: round(
        values.filter((v) => Math.abs(v) > 0.5).length / values.length,
        4,
      ),
      shareBelowMinus0_5pp: round(values.filter((v) => v < -0.5).length / values.length, 4),
      shareAbove0_5pp: round(values.filter((v) => v > 0.5).length / values.length, 4),
    };
  }
  return {
    books: stats.books,
    booksRejectedByGateO2: stats.gateFailBooks,
    selections: stats.selections,
    selectionsAtOrBelow1_01: stats.floorOrFallback,
    selectionsAtCap1000: stats.atCap,
    nonHundredthPrices: stats.nonHundredth,
    marketsMissingByKey: stats.missing,
    overroundDeviationFromDeclaredPp: dev,
    minOverroundPerCoverByType: Object.fromEntries(
      Object.entries(stats.minOverroundPerCover).map(([k, v]) => [k, round(v, 5)]),
    ),
    violationCounts: Object.fromEntries(tally.counts),
    violationExamples: Object.fromEntries(tally.examples),
  };
}

const result = {
  declaredMarginBps: {
    main: 600,
    correctScore: 1500,
    note: 'odds = 1 / (p (1 + margin)), so a book that partitions the outcomes has Σ 1/odds = 1.06 (cs 1.15) before rounding',
  },
  ratingGrid: {
    axis: AXIS,
    pairs: AXIS.length ** 4,
    priceFixtureThrew: throws,
    pairsWithout1x2Market: missing1x2.length === 0 ? 0 : 'see examples',
    pairsWithout1x2Examples: missing1x2,
    ...(summarise(gridStats, gridTally) as object),
  },
  namedScenarios: scenarioRows,
  scenarioViolations: Object.fromEntries(scenarioTally.counts),
  malformedRatings: weirdRows,
  mirrorSymmetry: { comparisons: mirrorChecked, broken: mirrorBroken, examples: mirrorExamples },
  homeAdvantage,
  premierLeague2026_27: {
    fixtures: fixturesPriced,
    fixturesWithAClubNotInCatalogue: fixturesNeutral,
    clubsNotInCatalogue: [...unseeded],
    fixturesOpenableUnderO1WithSeededRatingsAlone: calibratedByO1,
    loadedByAdapter: fixtures.matches.length,
    ...(summarise(fixtureStats, fixtureTally) as object),
  },
};
writeJson(outPath, result);
out(`grid books ${gridBooks}, throws ${throws}`);
out(JSON.stringify(Object.fromEntries(gridTally.counts)));
out(JSON.stringify(Object.fromEntries(fixtureTally.counts)));
out(JSON.stringify(result.mirrorSymmetry));

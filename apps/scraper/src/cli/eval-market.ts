import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  evaluateMarketPath,
  readMatches,
  roundReport,
  type Basis,
  type BinarySection,
  type MarketPathReport,
  type Score2,
  type Score3,
  type Section,
  type TernarySection,
} from '../eval/market-path';
import {
  CliFailure,
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  readInput,
  table,
  UsageError,
  type CliEnv,
} from './io';

const num = (x: number | null | undefined, digits = 4): string =>
  x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(digits);
const pct = (x: number | null | undefined): string =>
  x === null || x === undefined || Number.isNaN(x) ? '-' : `${(100 * x).toFixed(1)}%`;

const rel = (r: { value: number; lo: number; hi: number } | null): string =>
  r === null ? '-' : `${pct(r.value)} [${pct(r.lo)}, ${pct(r.hi)}]`;

const row3 = (name: string, s: Score3 | null | undefined): string[] => [
  name,
  String(s?.n ?? 0),
  num(s?.logLoss),
  num(s?.brier),
  num(s?.rps),
];
const row2 = (name: string, s: Score2 | null | undefined): string[] => [
  name,
  String(s?.n ?? 0),
  num(s?.logLoss),
  num(s?.brier),
];

function ternary(title: string, t: TernarySection): string[] {
  const rows = [row3('ours', t.ours), ...(t.consensus ? [row3('consensus', t.consensus)] : [])];
  rows.push(row3('base rate', t.baseRate));
  const out = ['', title, ...table(['forecast', 'n', 'log-loss', 'Brier', 'RPS'], rows)];
  if (t.vsPinnacle !== undefined) {
    out.push(
      '',
      `${title}: vs Pinnacle no-vig (n = ${t.vsPinnacle.n}; our log-loss vs Pinnacle ${rel(t.vsPinnacle.relLogLoss)})`,
      ...table(
        ['forecast', 'n', 'log-loss', 'Brier', 'RPS'],
        [row3('ours', t.vsPinnacle.ours), row3('pinnacle', t.vsPinnacle.pinnacle)],
      ),
    );
  }
  return out;
}

function binary(title: string, b: BinarySection, pinnacle = true): string[] {
  const rows = [row2('ours', b.ours), ...(b.consensus ? [row2('consensus', b.consensus)] : [])];
  rows.push(row2('base rate', b.baseRate));
  const out = [
    '',
    `${title}${b.calibration ? ` (calibration: bias ${num(b.calibration.biasPp, 2)} pp, ECE ${num(b.calibration.eceVsObservedPp, 2)} pp)` : ''}`,
    ...table(['forecast', 'n', 'log-loss', 'Brier'], rows),
  ];
  if (pinnacle && b.vsPinnacle.n > 0) {
    out.push(
      `  vs Pinnacle no-vig (n = ${b.vsPinnacle.n}): ours ${num(b.vsPinnacle.ours?.logLoss)}, Pinnacle ${num(b.vsPinnacle.pinnacle?.logLoss)}, ours vs Pinnacle ${rel(b.vsPinnacle.relLogLoss)}`,
    );
  }
  return out;
}

function sectionLines(s: Section): string[] {
  const ah = s.asianHandicap;
  return [
    `matches priced: ${s.matches}; fit residual mean ${num(s.fit.meanResidual)}, above the hold threshold ${pct(s.fit.shareAboveMax)}`,
    ...ternary('1X2', s.oneXTwo),
    ...binary('Over/under 2.5 (over)', s.overUnder25),
    ...binary('Both teams to score (results only, no book odds)', s.btts, false),
    ...binary(
      `Asian handicap, home side, lines we price (scored ${ah.scored}, push ${ah.push}, line not priced ${ah.unpricedLine}, no line ${ah.none})`,
      ah.result,
    ),
    ...ternary('Half-time 1X2 (results only, no book odds)', s.halfTime1x2),
    '',
    `Correct score (results only, no book odds; n = ${s.correctScore.n}): log-loss ours ${num(s.correctScore.logLoss)}, base rate ${num(s.correctScore.baseRateLogLoss)}`,
  ];
}

export function reportLines(r: MarketPathReport): string[] {
  const lines = [
    `Market-path evaluation (${r.basis} odds): ${r.rows} matches read, ${r.overall.matches} priced; skipped: no consensus ${r.skipped.no_consensus}, no totals ${r.skipped.no_totals}`,
    ...sectionLines(r.overall),
  ];
  if (r.byDivision.length > 1) {
    lines.push(
      '',
      'Per division',
      ...table(
        [
          'division',
          'matches',
          '1X2 LL ours',
          '1X2 LL cons.',
          '1X2 LL base',
          'O/U LL ours',
          'O/U LL base',
        ],
        r.byDivision.map(({ division, section: s }) => [
          division,
          String(s.matches),
          num(s.oneXTwo.ours?.logLoss),
          num(s.oneXTwo.consensus?.logLoss),
          num(s.oneXTwo.baseRate?.logLoss),
          num(s.overUnder25.ours?.logLoss),
          num(s.overUnder25.baseRate?.logLoss),
        ]),
      ),
    );
  }
  return lines;
}

/**
 * `eval market [--file <csv> ... | --dir <folder>] [--open] [--json]` (M-4 of
 * docs/feed-quality-plan.md): scores what the market pricing path (`priceFootballFromMarket`)
 * prices from the closing odds in football-data.co.uk files against the results: 1X2, over/under
 * 2.5, BTTS, Asian handicap, half-time 1X2 and correct score. Offline; reads files only.
 */
export async function evalMarket(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    file: { type: 'string', multiple: true },
    dir: { type: 'string' },
    open: { type: 'boolean' },
  });
  noPositionals(parsed);
  const files = (parsed.values.file as string[] | undefined) ?? [];
  const dir = optionalString(parsed, 'dir');
  if ((files.length === 0) === (dir === undefined)) {
    throw new UsageError('give --file <csv> (repeatable) or --dir <folder>, not both');
  }
  const paths =
    dir === undefined
      ? files
      : (
          await readdir(dir).catch((error: unknown) => {
            throw new CliFailure(
              `cannot read folder ${dir}: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
        )
          .filter((f) => f.toLowerCase().endsWith('.csv'))
          .sort()
          .map((f) => join(dir, f));
  if (paths.length === 0) throw new CliFailure(`no CSV files in ${String(dir)}`);
  const basis: Basis = parsed.values.open === true ? 'open' : 'close';
  const matches = [];
  for (const path of paths) {
    matches.push(...readMatches(await readInput(env, path, 'odds file'), basis));
  }
  const report = roundReport(evaluateMarketPath(matches, basis));
  emit(env, parsed, { files: paths, ...report }, [
    `Files: ${paths.length}`,
    ...reportLines(report),
  ]);
  return EXIT_OK;
}

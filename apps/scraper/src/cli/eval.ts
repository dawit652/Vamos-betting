import { closePriceEvents, listClosePrices, type Database } from '@vamos/db';
import {
  computeScorecard,
  type EdgeStats,
  type Score2,
  type Score3,
  type Section,
} from '../eval/scorecard';
import {
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  table,
  UsageError,
  type CliEnv,
  type ParsedArgs,
} from './io';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

const num = (x: number | null | undefined, digits = 4): string =>
  x === null || x === undefined ? '-' : x.toFixed(digits);
const pct = (x: number | null | undefined): string =>
  x === null || x === undefined ? '-' : `${(100 * x).toFixed(1)}%`;

function isoTime(parsed: ParsedArgs, name: string): Date | undefined {
  const text = optionalString(parsed, name);
  if (text === undefined) return undefined;
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) throw new UsageError(`--${name} is not an ISO time: "${text}"`);
  return at;
}

/** The window: the last N days up to now (default 7), or --from and --to. */
function window(parsed: ParsedArgs, now: Date): { from: Date; to: Date } {
  const daysText = optionalString(parsed, 'days');
  const from = isoTime(parsed, 'from');
  const to = isoTime(parsed, 'to');
  if (daysText !== undefined) {
    if (from !== undefined || to !== undefined) {
      throw new UsageError('use --days or --from and --to, not both');
    }
    const days = Number(daysText);
    if (!/^\d+$/.test(daysText) || days < 1 || days > MAX_DAYS) {
      throw new UsageError(`--days must be a whole number from 1 to ${MAX_DAYS}`);
    }
    return { from: new Date(now.getTime() - days * DAY_MS), to: now };
  }
  if (from === undefined && to === undefined) {
    return { from: new Date(now.getTime() - DEFAULT_DAYS * DAY_MS), to: now };
  }
  if (from === undefined || to === undefined) {
    throw new UsageError('--from and --to go together');
  }
  if (from >= to) throw new UsageError('--from must be before --to');
  return { from, to };
}

const score3Row = (name: string, s: Score3 | null): string[] => [
  name,
  num(s?.brier),
  num(s?.logLoss),
  num(s?.rps),
];
const score2Row = (name: string, s: Score2 | null): string[] => [
  name,
  num(s?.brier),
  num(s?.logLoss),
];
const edgeRow = (name: string, e: EdgeStats): string[] => [
  name,
  String(e.n),
  num(e.mean),
  num(e.median),
  pct(e.shareAboveZero),
];

function sectionLines(section: Section): string[] {
  const { sample, oneXTwo, overUnder, calibration, prices } = section;
  const lines: string[] = [];
  const add = (title: string, rows: string[]) => lines.push('', title, ...rows);
  add(
    'Sample (events with prices at close)',
    table(
      ['events', 'settled', 'void', 'pending'],
      [[sample.events, sample.settled, sample.void, sample.pending].map(String)],
    ),
  );
  add(
    `1X2, ours vs consensus (n = ${oneXTwo.oursVsConsensus.n})`,
    table(
      ['forecast', 'Brier', 'log-loss', 'RPS'],
      [
        score3Row('ours', oneXTwo.oursVsConsensus.ours),
        score3Row('consensus', oneXTwo.oursVsConsensus.consensus),
      ],
    ),
  );
  add(
    `1X2, ours vs consensus vs Pinnacle (n = ${oneXTwo.withPinnacle.n}; log-loss vs Pinnacle ${pct(oneXTwo.withPinnacle.relLogLossVsPinnacle)})`,
    table(
      ['forecast', 'Brier', 'log-loss', 'RPS'],
      [
        score3Row('ours', oneXTwo.withPinnacle.ours),
        score3Row('consensus', oneXTwo.withPinnacle.consensus),
        score3Row('pinnacle', oneXTwo.withPinnacle.pinnacle),
      ],
    ),
  );
  add(
    `Over/under 2.5, ours vs consensus (n = ${overUnder.oursVsConsensus.n})`,
    table(
      ['forecast', 'Brier', 'log-loss'],
      [
        score2Row('ours', overUnder.oursVsConsensus.ours),
        score2Row('consensus', overUnder.oursVsConsensus.consensus),
      ],
    ),
  );
  add(
    `Over/under 2.5, ours vs consensus vs Pinnacle (n = ${overUnder.withPinnacle.n}; log-loss vs Pinnacle ${pct(overUnder.withPinnacle.relLogLossVsPinnacle)})`,
    table(
      ['forecast', 'Brier', 'log-loss'],
      [
        score2Row('ours', overUnder.withPinnacle.ours),
        score2Row('consensus', overUnder.withPinnacle.consensus),
        score2Row('pinnacle', overUnder.withPinnacle.pinnacle),
      ],
    ),
  );
  add(
    'Calibration of our 1X2 (every selection of every scored event)',
    table(
      ['bin', 'n', 'mean predicted', 'observed'],
      calibration.map((b) => [b.bin, String(b.n), num(b.meanPredicted), num(b.observed)]),
    ),
  );
  const o = prices.overround;
  add(
    'Overround: ours vs the consensus (sum of implied probabilities)',
    table(
      ['market', 'ours n', 'ours mean', 'consensus n', 'consensus mean'],
      [['1X2', o.oneXTwo] as const, ['O/U 2.5', o.overUnder] as const].map(([name, m]) => [
        name,
        String(m.oursN),
        num(m.oursMean),
        String(m.consensusN),
        num(m.consensusMean),
      ]),
    ),
  );
  add(
    'Bettor edge (our odds x fair probability - 1; every captured selection)',
    table(
      ['against', 'n', 'mean', 'median', 'share > 0'],
      [edgeRow('Pinnacle', prices.edgeVsPinnacle), edgeRow('consensus', prices.edgeVsConsensus)],
    ),
  );
  add(
    'Best price (our odds against the best book)',
    table(
      ['n', 'ours above best', 'ours at least best'],
      [
        [
          String(prices.bestPrice.n),
          pct(prices.bestPrice.shareAbove),
          pct(prices.bestPrice.shareAtLeast),
        ],
      ],
    ),
  );
  return lines;
}

/** One row per group: the numbers that matter at a glance. */
function groupTable(
  label: string,
  groups: readonly { name: string; section: Section }[],
): string[] {
  return table(
    [
      label,
      'events',
      'settled',
      'void',
      'pending',
      'n 1X2',
      'Brier ours',
      'Brier cons.',
      'LL ours',
      'LL cons.',
      'n Pin.',
      'LL vs Pin.',
      'n O/U',
      'O/U Brier ours',
      'O/U Brier cons.',
      'edge vs Pin.',
      'above best',
    ],
    groups.map(({ name, section: s }) => [
      name,
      String(s.sample.events),
      String(s.sample.settled),
      String(s.sample.void),
      String(s.sample.pending),
      String(s.oneXTwo.oursVsConsensus.n),
      num(s.oneXTwo.oursVsConsensus.ours?.brier),
      num(s.oneXTwo.oursVsConsensus.consensus?.brier),
      num(s.oneXTwo.oursVsConsensus.ours?.logLoss),
      num(s.oneXTwo.oursVsConsensus.consensus?.logLoss),
      String(s.oneXTwo.withPinnacle.n),
      pct(s.oneXTwo.withPinnacle.relLogLossVsPinnacle),
      String(s.overUnder.oursVsConsensus.n),
      num(s.overUnder.oursVsConsensus.ours?.brier),
      num(s.overUnder.oursVsConsensus.consensus?.brier),
      num(s.prices.edgeVsPinnacle.mean),
      pct(s.prices.bestPrice.shareAbove),
    ]),
  );
}

/**
 * `eval scorecard [--days N | --from <iso> --to <iso>] [--json]` (rule M1, M-2 of
 * docs/feed-quality-plan.md): compares the prices recorded at betting close with the results,
 * overall, per competition and per pricing source. Read-only.
 */
export async function evalScorecard(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    days: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
  });
  noPositionals(parsed);
  const { from, to } = window(parsed, env.clock());
  const db: Database = await env.database();
  const rows = await listClosePrices(db, { from, to });
  const events = await closePriceEvents(db, [...new Set(rows.map((r) => r.eventId))]);
  const scorecard = computeScorecard(rows, events);
  emit(env, parsed, { from: from.toISOString(), to: to.toISOString(), ...scorecard }, [
    `Scorecard of the prices at betting close, captured ${from.toISOString()} to ${to.toISOString()}`,
    ...sectionLines(scorecard.overall),
    '',
    'Per competition',
    ...groupTable(
      'competition',
      scorecard.byCompetition.map((g) => ({ name: g.competition, section: g.section })),
    ),
    '',
    'Per pricing source',
    ...groupTable(
      'source',
      scorecard.byPricingSource.map((g) => ({ name: g.source, section: g.section })),
    ),
  ]);
  return EXIT_OK;
}

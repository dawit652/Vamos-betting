import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DEFAULT_MARKET_FAMILIES } from '@vamos/core';
import { loadMarketFamilies, saveFamilyHistory } from '@vamos/db';
import { familyHistoryTest, type FamilyHistoryReport } from '../eval/family-history';
import { readMatches } from '../eval/market-path';
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

/** A decimal flag within [min, max], or undefined when absent. */
function numberFlag(
  parsed: ReturnType<typeof parseCommandArgs>,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const text = optionalString(parsed, name);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!/^-?\d+(\.\d+)?$/.test(text) || value < min || value > max) {
    throw new UsageError(`--${name} takes a number from ${min} to ${max}, got "${text}"`);
  }
  return value;
}

const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

function reportLines(report: FamilyHistoryReport): string[] {
  const failed = report.families.filter((f) => !f.passed);
  return [
    `Matches: ${report.matches} (skipped: ${report.skipped.noFit} without a fit, ${report.skipped.residual} over the fit residual; ${report.skipped.noHalfTime} without half time priced full-time families only)`,
    `Families: ${report.families.length}, failed: ${failed.length}${failed.length > 0 ? ` (${failed.map((f) => f.family).join(', ')})` : ''}`,
    '',
    ...table(
      ['family', 'matches', 'selections', 'margin', 'hold', 'suggested', 'worst selection', 'pass'],
      report.families.map((f) => [
        f.family,
        String(f.matches),
        String(f.selections),
        pct(f.marginBps),
        pct(f.holdBps),
        pct(f.suggestedMarginBps),
        f.worst === null ? '-' : `${f.worst.key} ${pct(f.worst.lowerBps)} (n ${f.worst.n})`,
        f.passed ? 'yes' : 'NO',
      ]),
    ),
    '',
    'hold = 1 - returns / stakes of one unit on every listed selection at our price; worst selection = the largest one-sided 95% lower bound of fair yield (won / p - 1) among selections with 200+ decided matches; suggested = that bound rounded up to a whole point, never below the margin; pass = suggested <= margin and hold >= 0.',
  ];
}

/**
 * `eval families (--file <csv> ... | --dir <folder>) [--write] [--first-half-share x]
 * [--draw-correction rho] [--json]` (check 0.6, task A2): the
 * history test of every factory family on football-data.co.uk closing prices. Without --write it
 * reads files only and tests at the default margins; with --write it tests at the margins in the
 * database's settings and stores the result (setting `market_family_history`, audited), which the
 * weekly family job reads before letting a suspended family return. --first-half-share and
 * --draw-correction measure task 2.2's pricing switches (never with --write).
 */
export async function evalFamilies(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, {
    file: { type: 'string', multiple: true },
    dir: { type: 'string' },
    write: { type: 'boolean' },
    'first-half-share': { type: 'string' },
    'draw-correction': { type: 'string' },
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
  const matches = [];
  for (const path of paths) {
    matches.push(...readMatches(await readInput(env, path, 'odds file'), 'close'));
  }
  const share = numberFlag(parsed, 'first-half-share', 0.3, 0.7);
  const rho = numberFlag(parsed, 'draw-correction', -0.5, 0.5);
  const grids =
    share === undefined && rho === undefined
      ? undefined
      : {
          ...(share === undefined ? {} : { firstHalfShare: share }),
          ...(rho === undefined ? {} : { drawCorrection: rho }),
        };
  const write = parsed.values.write === true;
  if (write && (share !== undefined || rho !== undefined)) {
    throw new UsageError(
      '--write stores the test of production pricing; leave out --first-half-share and --draw-correction',
    );
  }
  const db = write ? await env.database() : null;
  const settings = db === null ? DEFAULT_MARKET_FAMILIES : await loadMarketFamilies(db);
  const report = familyHistoryTest(matches, settings, grids);
  if (report.matches === 0) throw new CliFailure('no match could be priced from these files');
  let stored: string | null = null;
  if (db !== null) {
    const testedAt = env.clock();
    await db.transaction((tx) =>
      saveFamilyHistory(
        tx,
        {
          testedAt,
          matches: report.matches,
          files: paths.map((p) => basename(p)),
          families: report.families,
        },
        env.actor,
      ),
    );
    stored = testedAt.toISOString();
  }
  emit(env, parsed, { files: paths, stored, grids: grids ?? null, ...report }, [
    `Files: ${paths.length}${share === undefined && rho === undefined ? '' : ` (first-half share ${share ?? 'time-based'}, draw correction ${rho ?? 'none'})`}`,
    ...reportLines(report),
    ...(stored === null ? [] : ['', `stored as setting market_family_history at ${stored}`]),
  ]);
  return EXIT_OK;
}

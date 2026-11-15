import type { Database } from '@vamos/db';
import { gatherWeeklyInputs } from '../eval/weekly-data';
import { buildWeeklyReport, lastCompleteWeek, parseWeekId } from '../eval/weekly-report';
import {
  EXIT_OK,
  emit,
  noPositionals,
  optionalString,
  parseCommandArgs,
  UsageError,
  type CliEnv,
} from './io';

/**
 * `report weekly [--week YYYY-Www] [--json]` (plan task 1.3): the measures of section 8 of
 * docs/plans/hulusport-parity-plan.md for one ISO week (default: the last complete week) with their
 * targets and a pass, fail or unknown mark. The scraper writes the same report once a week
 * by itself. Read-only.
 */
export async function reportWeekly(args: string[], env: CliEnv): Promise<number> {
  const parsed = parseCommandArgs(args, { week: { type: 'string' } });
  noPositionals(parsed);
  const now = env.clock();
  const weekText = optionalString(parsed, 'week');
  const week = weekText === undefined ? lastCompleteWeek(now) : parseWeekId(weekText);
  if (week === null) throw new UsageError('--week must be an ISO week as YYYY-Www, e.g. 2026-W46');
  const db: Database = await env.database();
  const report = buildWeeklyReport(await gatherWeeklyInputs(db, week, now));
  emit(env, parsed, report.json, report.markdown.trimEnd().split('\n'));
  return EXIT_OK;
}

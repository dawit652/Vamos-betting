import { readFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { Database, ScrapeActor } from '@vamos/db';
import type { PoliteFetcher } from '@vamos/scraper';

/** Exit codes of the CLI: 0 success, 1 the command failed, 2 the command line is wrong. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** The command line is wrong (exit 2); the message is followed by the usage text. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** The command cannot continue (exit 1). Every line goes to stderr. */
export class CliFailure extends Error {
  override readonly name = 'CliFailure';
  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
  }
}

/** Everything a command needs from the outside; tests pass their own. */
export interface CliEnv {
  /** Results: stdout, one string per line. */
  out(line: string): void;
  /** Problems and notes: stderr. */
  err(line: string): void;
  readFile(path: string): Promise<string>;
  /** Opened on first use, so commands that need no database run without one. */
  database(): Promise<Database>;
  /** Likewise: only dry-fetch needs the network. */
  fetcher(): PoliteFetcher;
  clock(): Date;
  /** The audit actor of every change the CLI makes. */
  actor: ScrapeActor;
  /**
   * The scraper's C-2 settings (SCRAPER_PRIORITY_COMPETITIONS, SCRAPER_SKIP_REDUNDANT_SCORES), for
   * commands that replay the scheduler. Absent: the defaults (every competition priority, no skip).
   */
  pollingSettings?(): PollingSettings;
}

/** ScraperConfig's C-2 fields. */
export interface PollingSettings {
  priorityCompetitions: string[] | null;
  skipRedundantScores: boolean;
}

export const defaultReadFile = (path: string): Promise<string> => readFile(path, 'utf8');

export interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** parseArgs, with its errors turned into UsageError. `--json` is accepted by every command. */
export function parseCommandArgs(args: string[], options: ParseArgsConfig['options']): ParsedArgs {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' }, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values, positionals };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

export function requiredString(parsed: ParsedArgs, name: string): string {
  const value = parsed.values[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

export function optionalString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function noPositionals(parsed: ParsedArgs): void {
  if (parsed.positionals.length > 0) {
    throw new UsageError(`unexpected argument "${parsed.positionals[0]}"`);
  }
}

/** Prints either the JSON document (`--json`) or the text lines. */
export function emit(
  env: CliEnv,
  parsed: ParsedArgs,
  json: unknown,
  lines: readonly string[],
): void {
  if (parsed.values.json === true) env.out(JSON.stringify(json, null, 2));
  else for (const line of lines) env.out(line);
}

/** Reads a file; a missing file is a failure, not a crash. */
export async function readInput(env: CliEnv, path: string, what: string): Promise<string> {
  try {
    return await env.readFile(path);
  } catch (error) {
    throw new CliFailure(
      `cannot read ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliFailure(
      `${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Plain left-aligned table. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

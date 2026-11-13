import { pathToFileURL } from 'node:url';
import {
  ConfigError,
  loadConfig,
  loadDotEnv,
  scraperUserAgent,
  type AppConfig,
} from '@vamos/config';
import { claimOperatingMode, createDb, DomainError, type Database, type DbHandle } from '@vamos/db';
import { PoliteFetcher } from '@vamos/scraper';
import { aliasesImport, aliasesList, aliasesRemove } from './cli/aliases';
import { dryFetch, dryParse } from './cli/dry-run';
import { evalScorecard } from './cli/eval';
import { evalMarket } from './cli/eval-market';
import { evalFamilies } from './cli/eval-families';
import {
  CliFailure,
  defaultReadFile,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
  type CliEnv,
} from './cli/io';
import { envSecretReader } from './lib/secrets';
import { ratingsBackfill, ratingsList, ratingsSet } from './cli/ratings';
import { sourcesBudget } from './cli/budget';
import { sourcesCoverage } from './cli/coverage';
import { reviewGaps } from './cli/gaps';
import { reportWeekly } from './cli/report';
import { reviewCounts, reviewLadderShadow, reviewResultsAudit } from './cli/review';
import { sourcesList, sourcesTruthCheck, sourcesUpsert } from './cli/sources';

/**
 * The source and ratings command line (docs/scraper-plan/07-sources-ratings-and-shadow-mode.md).
 * Results go to stdout; problems go to stderr; the exit code is 0 for success,
 * 1 when the command failed or refused, 2 for a wrong command line.
 */
export const USAGE = `usage: pnpm --filter @vamos/scraper-app cli <command> [options]

commands:
  sources list [--json]
      Every source with its state (enabled or disabled, last run, failures, open review items).
  sources coverage
      Per competition: which enabled upstreams give fixtures, full-time scores, half-time scores and
      a stated score basis (extra time), from the source configs; flags competitions with fewer than
      two full-time upstreams (single-result-upstream: rule R2 needs two). Read-only.
  sources budget [--priority slug,slug|all] [--skip-redundant-scores on|off]
      The Odds API credits a day per source from the read schedule and the next 30 days of fixtures,
      against the plan quota and reset date; actual spend (24 h, month to date) and credits left per
      key; days until the credit guard leaves normal at the estimated rate. Each source's tier
      (priority or standard) and whether its scores are skipped as a redundant upstream come from
      SCRAPER_PRIORITY_COMPETITIONS and SCRAPER_SKIP_REDUNDANT_SCORES; the flags try other values
      without changing them (--priority all: every competition priority). Read-only.
  sources truth-check [--upstream <name>] [--since YYYY-MM-DD] [--write]
      Trust is measured: per upstream, how often its finished regular-time scores (football) match
      the applied result, for events resulted since the date (default: 1 July of this season): the
      full-time score, and the half-time score when both have one; one comparison per event (an
      upstream with several sources disagrees when any does). Prints compared, agreed, rate and
      trust level. --write stores the rows (and up to 20 recent disagreements) in
      scrape_source_trust, which the result ladder reads; the scraper also does this once a day.
      Partly circular: a result applied on an upstream's own vote agrees with it by construction, so
      the table counts those events (from the result audit) and the rate without them.
  sources upsert --file source.json
      Validates the config (createAdapter), then creates or updates the source.
      A new source starts DISABLED; an existing one keeps its enabled flag.
  dry-parse --source-file source.json --document page.html [--url <planned url>] [--at <iso time>]
            [--content-type <type>] [--limit <n>]
      Parses a saved document and prints observations and issues. No database, no network.
  dry-fetch --source-file source.json [--limit <n>]
      Fetches through the polite fetcher (allow-list, robots.txt, rate limit) and parses.
      Prints only; writes nothing to the database or the archive.
  aliases import --file aliases.csv
      Bulk team and competition aliases (columns: kind,sport,alias,target,source). Idempotent;
      all or nothing.
  aliases list [--kind team|competition] [--q text]
      Aliases, newest first, with their ids (the name or the target contains the text).
  aliases remove --id <id>
      Removes one alias (team or competition). The next promotion pass re-resolves
      observations that used it. Audited.
  ratings backfill --file results.json --competition <slug> [--dry-run]
      Learns team ratings from historical results. Re-running the same file changes nothing;
      refuses teams with manual = 1 or with more matches than the file holds.
  ratings set --team <name> --attack <n> --defence <n> [--matches <n>] [--dry-run]
      Sets a football team's ratings by hand (sets manual = 1, audited). Attack and defence
      are multipliers of the league average (1 = average, a higher defence concedes more),
      between 0.35 and 3. Refuses unknown or ambiguous team names. Prints before and after.
  ratings list [--team text] [--unrated [--min-matches n]]
      Football teams that have ratings: attack, defence, matches, manual. --unrated lists the
      teams of upcoming matches whose ratings are not calibrated (rule O1), most matches first.
  review counts
      Open review items per kind (zeros included) with the date of the oldest, and a total.
  review gaps [--competition slug] [--csv]
      Clubs sources use that the catalogue lacks (open unknown_team items), per competition and
      normalised spelling, with sources, rows and first seen. --csv prints
      competition,spelling,sources,rows,first_seen for "add club" review. Read-only.
  review results-audit [--days N]
      Results applied in the last N days (default 7, 1 to 90) and at least 48 h ago: the applied
      score (and half-time score) against the latest observation of every enabled source
      (football-data.org included), flagging any source whose full-time or half-time score differs;
      latency from the assumed final whistle (kickoff + 105 min) to the moment the result was
      applied, per competition (count, mismatches, median, p90) against the targets (median 20 min,
      p90 30 min). Read-only.
  review ladder-shadow [--since YYYY-MM-DD]
      What the result ladder (rungs B to D) would have done for events the result gate did not
      settle, against what then happened: an apply decision against the applied score (match,
      mismatch, not resulted yet), a void decision against whether the match was played or ended
      void. Then a summary per rung and reason (decisions, agreed, disagreed, pending). Nothing is
      applied or voided from the ladder. Default --since: 28 days ago. Read-only.
  report weekly [--week YYYY-Www]
      The weekly report (plan task 1.3): the measures of section 8 of the Hulusport parity plan for
      one ISO week (default: the last complete week) with their targets and a pass, fail or unknown
      mark; a measure the data cannot answer yet is unknown, with the reason. The scraper writes the
      same report to <archive>/reports/weekly-<week>.md and .json once a week by itself. Read-only.
  eval scorecard [--days N | --from <iso> --to <iso>]
      Prices at betting close against the results (last 7 days by default, N from 1 to 90):
      sample, 1X2 and over/under scores of ours, the consensus and Pinnacle, calibration, overround,
      bettor edge and best-price shares; overall, per competition and per pricing source. Read-only.
  eval market (--file <csv> [--file ...] | --dir <folder>) [--open]
      Offline: what priceFootballFromMarket prices from football-data.co.uk closing odds (--open: the
      opening columns) against the results, per match from the odds of several books: 1X2, over/under
      2.5, BTTS, Asian handicap, half-time 1X2 and correct score, with Pinnacle no-vig and the base
      rate as references (BTTS, half time and correct score have no book odds in the files). Reads files only.
  eval families (--file <csv> [--file ...] | --dir <folder>) [--write] [--first-half-share x] [--draw-correction=rho]
      The history test of the market factory's families (check 0.6): every factory-only market priced
      from the expected goals fitted to football-data.co.uk closing odds and settled on the real score;
      per family the hold at its margin, the worst selection and a suggested margin. --write tests at
      the database's margins and stores the result, which lets a suspended family return.
      --first-half-share (0.3..0.7) and --draw-correction (-0.5..0.5) measure the pricing switches of
      task 2.2 instead (not with --write).

every command accepts --json (machine-readable output); review gaps also --csv.
exit codes: 0 success, 1 failed or refused, 2 wrong command line.`;

type Command = (args: string[], env: CliEnv) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  'sources list': sourcesList,
  'sources coverage': sourcesCoverage,
  'sources budget': sourcesBudget,
  'sources upsert': sourcesUpsert,
  'sources truth-check': sourcesTruthCheck,
  'dry-parse': dryParse,
  'dry-fetch': dryFetch,
  'aliases import': aliasesImport,
  'aliases list': aliasesList,
  'aliases remove': aliasesRemove,
  'ratings backfill': ratingsBackfill,
  'ratings set': ratingsSet,
  'ratings list': ratingsList,
  'review counts': reviewCounts,
  'review gaps': reviewGaps,
  'review results-audit': reviewResultsAudit,
  'review ladder-shadow': reviewLadderShadow,
  'report weekly': reportWeekly,
  'eval scorecard': evalScorecard,
  'eval market': evalMarket,
  'eval families': evalFamilies,
};

/** Words that take a sub-command; the rest are commands on their own. */
const GROUPS = new Set(['sources', 'aliases', 'ratings', 'review', 'eval', 'report']);

/** Runs one command line and returns the exit code; never throws and never exits. */
export async function runCli(argv: readonly string[], env: CliEnv): Promise<number> {
  try {
    const [first, ...rest] = argv;
    if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
      env.out(USAGE);
      return first === undefined ? EXIT_USAGE : EXIT_OK;
    }
    let name = first;
    let args = rest;
    if (GROUPS.has(first)) {
      const sub = rest[0];
      if (sub === undefined || sub.startsWith('-')) {
        throw new UsageError(`"${first}" needs a sub-command`);
      }
      name = `${first} ${sub}`;
      args = rest.slice(1);
    }
    const command = COMMANDS[name];
    if (command === undefined) throw new UsageError(`unknown command "${name}"`);
    if (args.includes('--help') || args.includes('-h')) {
      env.out(USAGE);
      return EXIT_OK;
    }
    return await command(args, env);
  } catch (error) {
    if (error instanceof UsageError) {
      env.err(`error: ${error.message}`);
      env.err(USAGE);
      return EXIT_USAGE;
    }
    if (error instanceof CliFailure) {
      env.err(`error: ${error.message}`);
      for (const detail of error.details) env.err(`  ${detail}`);
      return EXIT_FAILED;
    }
    if (error instanceof DomainError) {
      env.err(`error: ${error.message} (${error.code})`);
      return EXIT_FAILED;
    }
    env.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
}

/** The real environment: config from .env / the process environment, database opened on first use. */
function realEnv(): { env: CliEnv; close: () => Promise<void> } {
  let config: AppConfig | null = null;
  const getConfig = (): AppConfig => {
    if (config === null) {
      loadDotEnv();
      try {
        config = loadConfig();
      } catch (error) {
        if (error instanceof ConfigError) throw new CliFailure(error.message);
        throw error;
      }
    }
    return config;
  };
  let handle: DbHandle | null = null;
  let fetcher: PoliteFetcher | null = null;
  const env: CliEnv = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    readFile: defaultReadFile,
    clock: () => new Date(),
    actor: { system: 'cli' },
    pollingSettings: () => {
      const { priorityCompetitions, skipRedundantScores } = getConfig().scraper;
      return { priorityCompetitions, skipRedundantScores };
    },
    database: async (): Promise<Database> => {
      if (handle === null) {
        const cfg = getConfig();
        const opened = createDb(cfg.databaseUrl, { max: 2 });
        try {
          // A demo database (play money) must never serve licensed mode, nor the reverse.
          await claimOperatingMode(opened.db, cfg.mode);
        } catch (error) {
          await opened.close();
          throw new CliFailure(
            `could not use the database (has "pnpm db:migrate" run?): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        handle = opened;
      }
      return handle.db;
    },
    fetcher: () => {
      if (fetcher === null) {
        const cfg = getConfig();
        fetcher = new PoliteFetcher({
          userAgent: scraperUserAgent(cfg.scraper),
          robots: cfg.scraper.robots,
          maxConcurrency: cfg.scraper.maxConcurrency,
          // The same variables the service reads (loadDotEnv above filled the environment).
          secrets: envSecretReader(),
        });
      }
      return fetcher;
    },
  };
  return {
    env,
    close: async () => {
      await handle?.close();
    },
  };
}

async function main(): Promise<void> {
  const { env, close } = realEnv();
  let code: number;
  try {
    code = await runCli(process.argv.slice(2), env);
  } finally {
    await close();
  }
  process.exitCode = code;
}

// Run only when started as a program, not when a test imports runCli.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

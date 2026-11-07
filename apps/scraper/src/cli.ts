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
import { feedReport } from './cli/feed';
import { sourcesList, sourcesUpsert } from './cli/sources';

/**
 * The source and ratings command line (docs/scraper-plan/07-sources-ratings-and-shadow-mode.md).
 * Results go to stdout; problems go to stderr; the exit code is 0 for success,
 * 1 when the command failed or refused, 2 for a wrong command line.
 */
export const USAGE = `usage: pnpm --filter @vamos/scraper-app cli <command> [options]

commands:
  sources list [--json]
      Every source with its state (enabled or disabled, last run, failures, open review items).
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
  ratings list [--team text]
      Football teams that have ratings: attack, defence, matches, manual.
  feed report [--days <n>]
      Read-only. Why upcoming matches have betting closed (odds locked), in plain English, with the
      competition policies, the sources and the open review queue. --days is 1 to 30 (default 7).

every command accepts --json (machine-readable output).
exit codes: 0 success, 1 failed or refused, 2 wrong command line.`;

type Command = (args: string[], env: CliEnv) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  'sources list': sourcesList,
  'sources upsert': sourcesUpsert,
  'dry-parse': dryParse,
  'dry-fetch': dryFetch,
  'aliases import': aliasesImport,
  'aliases list': aliasesList,
  'aliases remove': aliasesRemove,
  'ratings backfill': ratingsBackfill,
  'ratings set': ratingsSet,
  'ratings list': ratingsList,
  'feed report': feedReport,
};

/** Words that take a sub-command; the rest are commands on their own. */
const GROUPS = new Set(['sources', 'aliases', 'ratings', 'feed']);

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
    config: getConfig,
    actor: { system: 'cli' },
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

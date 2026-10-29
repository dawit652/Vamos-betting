import type { Database } from '@vamos/db';
import { createTestDatabase } from '@vamos/db/testing';
import type { PoliteFetcher } from '@vamos/scraper';
import { seedCatalog } from '@vamos/db';
import { runCli } from '../src/cli';
import type { CliEnv } from '../src/cli/io';
import { T0 } from './helpers';

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliHarness {
  /** Files the commands can read, by path. */
  files: Map<string, string>;
  run(...argv: string[]): Promise<CliRun>;
}

/**
 * Runs commands in process with in-memory files and captured output.
 * Without `db` / `fetcher` a command that touches them fails loudly, which
 * is how the tests prove that dry-parse needs neither.
 */
export function cliHarness(deps: { db?: Database; fetcher?: PoliteFetcher } = {}): CliHarness {
  const files = new Map<string, string>();
  return {
    files,
    run: async (...argv) => {
      const out: string[] = [];
      const err: string[] = [];
      const env: CliEnv = {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        readFile: (path) => {
          const text = files.get(path);
          return text === undefined
            ? Promise.reject(new Error(`ENOENT: no such file ${path}`))
            : Promise.resolve(text);
        },
        database: () =>
          deps.db === undefined
            ? Promise.reject(new Error('this command must not open the database'))
            : Promise.resolve(deps.db),
        fetcher: () => {
          if (deps.fetcher === undefined) throw new Error('this command must not fetch');
          return deps.fetcher;
        },
        clock: () => new Date(T0),
        actor: { system: 'cli-test' },
      };
      const code = await runCli(argv, env);
      return { code, stdout: out.join('\n'), stderr: err.join('\n') };
    },
  };
}

/** A migrated database with the demo catalogue (teams, competitions) and nothing else. */
export async function catalogDatabase() {
  const db = await createTestDatabase();
  await seedCatalog(db.db);
  return db;
}

export const OPENFOOTBALL_SOURCE = {
  id: 'cli-openfootball',
  name: 'openfootball (cli test)',
  adapter: 'openfootball',
  upstream: 'openfootball',
  config: {
    allowedHosts: ['raw.githubusercontent.com'],
    requests: [
      {
        url: 'https://raw.githubusercontent.com/test/en1.json',
        competition: 'Premier League',
      },
    ],
    timeZone: 'Europe/London',
    sport: 'football',
  },
};

export const JSON_SOURCE = {
  id: 'cli-json',
  name: 'json api (cli test)',
  adapter: 'generic-json',
  upstream: 'example-api',
  config: {
    allowedHosts: ['api.example.com'],
    requests: [{ url: 'https://api.example.com/events', purpose: 'both' }],
    sport: 'football',
    recordsPath: 'data.events[*]',
    fields: {
      home: 'h',
      away: 'a',
      competition: { path: 'league' },
      kickoff: { path: 'kick', format: 'iso' },
      externalRef: 'id',
      status: { path: 'st', map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' } },
      score: { homePath: 'hs', awayPath: 'as' },
    },
    scoreBasis: 'regular_time',
  },
};

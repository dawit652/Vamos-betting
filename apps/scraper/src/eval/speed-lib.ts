/**
 * Shared harness of the speed / resilience evaluation (docs/scraper-evaluation/02-speed-and-resilience.md).
 *
 * It is the idea of `apps/scraper/test/helpers.ts` (fake network, injectable clock, real Postgres), but
 * - it uses ONLY the scratch database `vamos_eval_speed` (it refuses any other name),
 * - the fetcher keeps the PRODUCTION defaults (3 attempts, back-off, 5-minute breaker, 2 s host interval,
 *   5 MiB limit); only the clock, the sleep and the transport are injected, and a sleep moves the
 *   simulated clock, so a retry costs simulated time exactly as it would cost real time,
 * - the database is reset between scenarios with `pg_restore --clean` of a dump taken right after
 *   `pnpm db:migrate && pnpm db:seed`.
 *
 * Nothing here changes production code or configuration.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@vamos/config';
import {
  addCompetitionAlias,
  addTeamAlias,
  createDb,
  getSource,
  loadCatalogIds,
  setCompetitionPolicy,
  setSourceEnabled,
  setTeamRatings,
  upsertSource,
  type CatalogIds,
  type DbHandle,
  type ScrapeSource,
} from '@vamos/db';
import {
  FileRawArchive,
  normalizeName,
  PoliteFetcher,
  type PoliteFetcherOptions,
} from '@vamos/scraper';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createScraperContext, type ScraperContext } from '../context';
import { runSource, type RunSourceResult } from '../pipeline/run-source';

export const EVAL_DB_NAME = 'vamos_eval_speed';
export const EVAL_DB_URL = `postgres://vamos:vamos@localhost:5432/${EVAL_DB_NAME}`;
export const EVAL_REDIS_URL = 'redis://localhost:6379';
export const EVAL_REDIS_DB = 10;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Hit = {
  status: number;
  body: string | Uint8Array;
  headers?: Record<string, string>;
};
/** What the fake network does for one request. `delayMs` is simulated time spent on the wire. */
export type Handler = (request: {
  url: string;
  headers: Record<string, string>;
}) => Hit | { throw: Error } | { hang: true };

export interface Network {
  /** Serves a fixed document for a URL (with an ETag the fake honours: a matching If-None-Match gets 304). */
  serve(url: string, hit: Hit | string): void;
  handle(url: string, handler: Handler): void;
  clear(url: string): void;
  /** Requests seen per URL (every attempt, redirects included). */
  requests: Map<string, number>;
  bytes: number;
}

export interface EvalHarness {
  ctx: ScraperContext;
  handle: DbHandle;
  ids: CatalogIds;
  net: Network;
  fetcher: PoliteFetcher;
  /** Sleeps the fetcher asked for (ms), in order. */
  sleeps: number[];
  at(date: Date): void;
  advance(ms: number): void;
  now(): Date;
  team(sport: string, shortName: string): string;
  competition(slug: string): string;
  addSource(source: SourceDef, enable?: boolean): Promise<void>;
  addCompetitionAlias(label: string, slug: string, sourceId?: string | null): Promise<void>;
  addTeamAlias(raw: string, shortName: string, sourceId?: string | null): Promise<void>;
  enableCompetition(
    slug: string,
    flags?: { autoOpen?: boolean; autoResults?: boolean },
  ): Promise<void>;
  /** Marks the catalogue ratings of the competition's teams as reviewed (manual = 1), values unchanged. */
  reviewRatings(shortNames: readonly string[]): Promise<number>;
  source(id: string): Promise<ScrapeSource>;
  run(id: string): Promise<RunSourceResult>;
  count(sql: string, params?: unknown[]): Promise<number>;
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface SourceDef {
  id: string;
  name: string;
  adapter: 'openfootball' | 'generic-json' | 'generic-html';
  upstream: string;
  config: Record<string, unknown>;
}

export interface OpenOptions {
  /** Where raw snapshots go (a directory of its own; it is emptied). */
  archiveDir: string;
  /** Start of simulated time. */
  start: Date;
  /** Passed to the PoliteFetcher on top of the production defaults. */
  fetcher?: Partial<PoliteFetcherOptions>;
  /** Redis key prefix suffix. */
  tag?: string;
  /** Database pool size (production uses 10). */
  poolMax?: number;
}

/** Restores the database to its post-seed state (a dump taken by the caller, see README of the eval). */
export function resetDatabase(dumpFile: string): void {
  execFileSync(
    'pg_restore',
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '-h',
      'localhost',
      '-U',
      'vamos',
      '-d',
      EVAL_DB_NAME,
      dumpFile,
    ],
    { env: { ...process.env, PGPASSWORD: 'vamos' }, stdio: ['ignore', 'ignore', 'ignore'] },
  );
}

export function assertScratch(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (name !== EVAL_DB_NAME) throw new Error(`refusing to use database "${name}"`);
}

export async function openEval(options: OpenOptions): Promise<EvalHarness> {
  assertScratch(EVAL_DB_URL);
  rmSync(options.archiveDir, { recursive: true, force: true });
  mkdirSync(options.archiveDir, { recursive: true });
  const handle = createDb(EVAL_DB_URL, { max: options.poolMax ?? 10 });
  const tag = options.tag ?? `${process.pid}`;
  const redis = new Redis(EVAL_REDIS_URL, {
    db: EVAL_REDIS_DB,
    keyPrefix: `eval-speed:${tag}:`,
    maxRetriesPerRequest: 2,
  });
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    FEED_PROVIDER: 'scraped',
    SCRAPER_ARCHIVE_DIR: options.archiveDir,
    SCRAPER_PORT: '0',
    DATABASE_URL: EVAL_DB_URL,
  });

  let clock = new Date(options.start);
  const sleeps: number[] = [];
  const handlers = new Map<string, Handler>();
  const net: Network = {
    requests: new Map(),
    bytes: 0,
    serve: (url, hit) => {
      const h: Hit = typeof hit === 'string' ? { status: 200, body: hit } : hit;
      handlers.set(url, () => h);
    },
    handle: (url, handler) => {
      handlers.set(url, handler);
    },
    clear: (url) => {
      handlers.delete(url);
    },
  };
  const fetcher = new PoliteFetcher({
    userAgent: 'NahubetEval/1.0',
    robots: 'off',
    ...options.fetcher,
    now: () => clock.getTime(),
    random: () => 0.5,
    sleep: (ms) => {
      sleeps.push(ms);
      clock = new Date(clock.getTime() + ms);
      return Promise.resolve();
    },
    fetchImpl: (input, init) => {
      net.requests.set(input, (net.requests.get(input) ?? 0) + 1);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const handler = handlers.get(input);
      if (handler === undefined) {
        return Promise.resolve(new Response('not found', { status: 404 }));
      }
      const out = handler({ url: input, headers });
      if ('throw' in out) return Promise.reject(out.throw);
      if ('hang' in out) {
        // A server that never answers: the fetcher's own timer must cut it (its abort signal rejects us).
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('This operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      const etag = out.headers?.etag;
      if (out.status === 200 && etag !== undefined && headers['if-none-match'] === etag) {
        return Promise.resolve(new Response(null, { status: 304 }));
      }
      const body = typeof out.body === 'string' ? out.body : Buffer.from(out.body);
      net.bytes += typeof body === 'string' ? Buffer.byteLength(body) : body.length;
      return Promise.resolve(
        new Response(body, {
          status: out.status,
          headers: { 'content-type': 'application/json', ...out.headers },
        }),
      );
    },
  });
  const ctx = createScraperContext({
    config,
    db: handle.db,
    redis,
    logger: pino({ level: 'silent' }),
    clock: () => new Date(clock.getTime()),
    fetcher,
    archive: new FileRawArchive(join(options.archiveDir), { now: () => new Date(clock.getTime()) }),
    channel: `eval-speed:${tag}:live`,
  });
  const ids = await loadCatalogIds(handle.db);
  const actor = { system: 'eval' };
  const team = (sport: string, shortName: string): string => {
    const id = ids.teams.get(`${sport}/${shortName}`);
    if (id === undefined) throw new Error(`no team ${sport}/${shortName}`);
    return id;
  };
  const competition = (slug: string): string => {
    const id = ids.competitions.get(`football/${slug}`);
    if (id === undefined) throw new Error(`no competition ${slug}`);
    return id;
  };
  const rows = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await handle.pool.query(sql, params)).rows as T[];
  return {
    ctx,
    handle,
    ids,
    net,
    fetcher,
    sleeps,
    at: (date) => {
      clock = new Date(date.getTime());
    },
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => new Date(clock.getTime()),
    team,
    competition,
    addSource: async (source, enable = true) => {
      await handle.db.transaction(async (tx) => {
        await upsertSource(tx, source, actor);
        if (enable) await setSourceEnabled(tx, source.id, true, actor);
      });
    },
    addCompetitionAlias: async (label, slug, sourceId = null) => {
      await handle.db.transaction((tx) =>
        addCompetitionAlias(
          tx,
          {
            sportId: 'football',
            aliasNorm: normalizeName(label),
            sourceId,
            competitionId: competition(slug),
          },
          actor,
        ),
      );
    },
    addTeamAlias: async (raw, shortName, sourceId = null) => {
      await handle.db.transaction((tx) =>
        addTeamAlias(
          tx,
          {
            sportId: 'football',
            aliasNorm: normalizeName(raw),
            sourceId,
            teamId: team('football', shortName),
          },
          actor,
        ),
      );
    },
    enableCompetition: async (slug, flags = {}) => {
      await handle.db.transaction((tx) =>
        setCompetitionPolicy(
          tx,
          competition(slug),
          {
            enabled: true,
            autoOpen: flags.autoOpen ?? false,
            autoResults: flags.autoResults ?? false,
          },
          actor,
        ),
      );
    },
    reviewRatings: async (shortNames) => {
      let n = 0;
      for (const shortName of shortNames) {
        const id = team('football', shortName);
        const [row] = await rows<{ ratings: Record<string, number> | null }>(
          'select ratings from teams where id = $1',
          [id],
        );
        const current = row?.ratings ?? { attack: 1, defence: 1 };
        await handle.db.transaction((tx) =>
          setTeamRatings(tx, id, { ...current, manual: 1 }, actor),
        );
        n += 1;
      }
      return n;
    },
    source: async (id) => (await getSource(handle.db, id))!,
    run: async (id) => runSource(ctx, (await getSource(handle.db, id))!, { trigger: 'schedule' }),
    count: async (sql, params = []) =>
      Number((await rows<{ n: string | bigint }>(sql, params))[0]?.n ?? 0),
    rows,
    close: async () => {
      await redis.quit().catch(() => undefined);
      await handle.close();
    },
  };
}

/** Standard single-league openfootball source of the evaluation. */
export function openfootballSource(
  id: string,
  url: string,
  competition: string,
  timeZone: string,
): SourceDef {
  return {
    id,
    name: `openfootball ${id}`,
    adapter: 'openfootball',
    upstream: 'openfootball community (github.com/openfootball/football.json, CC0)',
    config: {
      allowedHosts: ['raw.githubusercontent.com'],
      requests: [{ url, competition }],
      timeZone,
      sport: 'football',
    },
  };
}

export function etagOf(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i += 1) h = ((h * 33) ^ body.charCodeAt(i)) >>> 0;
  return `"${h.toString(16)}-${body.length}"`;
}

/** Peak resident memory of this process so far, MiB. */
export function rssMiB(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

export function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a (n=0)' : `${((100 * part) / whole).toFixed(1)}% (n=${whole})`;
}

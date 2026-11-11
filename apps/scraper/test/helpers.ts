import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@vamos/config';
import {
  getSource,
  loadCatalogIds,
  seedCatalog,
  setCompetitionPolicy,
  setSourceEnabled,
  setTeamRatings,
  upsertSource,
  type CatalogIds,
  type ScrapeSource,
} from '@vamos/db';
import { createTestDatabase } from '@vamos/db/testing';
import { FileRawArchive, PoliteFetcher } from '@vamos/scraper';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createScraperContext, type ScraperContext } from '../src/context';
import { runSource, type RunSourceResult } from '../src/pipeline/run-source';

export const SETUP_TIMEOUT = 120_000;
export const TEST_TIMEOUT = 60_000;
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** "Now" of most tests: kickoff is 4 days and 3 hours (99 hours) ahead. */
export const T0 = new Date('2026-10-29T12:00:00Z');
export const KICKOFF = new Date('2026-11-02T15:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 3_600_000;

export const URL_A = 'https://raw.githubusercontent.com/test/en1.json';
export const URL_B = 'https://api.example.com/events';

export type Hit = { status: number; body: string; headers?: Record<string, string> };

export interface Harness {
  ctx: ScraperContext;
  pool: {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  };
  ids: CatalogIds;
  premier: string;
  team(shortName: string): string;
  /** Moves the shared clock (also the fetcher's). */
  at(date: Date): void;
  advance(ms: number): void;
  now(): Date;
  /** What the fake network answers for a URL (default 404). */
  serve(url: string, hit: Hit | string): void;
  /** Every request the fetcher sent: the URL and its headers, oldest first. */
  requests: Array<{ url: string; headers: Record<string, string> }>;
  source(id: string): Promise<ScrapeSource>;
  run(id: string): Promise<RunSourceResult>;
  count(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Both teams of the sample fixture have ratings from enough matches (O1). Default true. */
  calibrated?: boolean;
  autoResults?: boolean;
  /** Upstream of the generic-json source (default 'example-api'). */
  upstreamB?: string;
  /** Secrets the fetcher may read by name (SCRAPER_SECRET_*), for sources that need a key. */
  secrets?: Record<string, string>;
  /** SCRAPER_HALF_TIME_MARKETS (rule O6); default the config's own default. */
  halfTimeMarkets?: 'all' | 'covered';
  /** SCRAPER_AUTO_ALIAS=on (rule N4); default off. */
  autoAlias?: boolean;
  /** SCRAPER_PRIORITY_COMPETITIONS (C-2); default unset (every competition priority). */
  priorityCompetitions?: string;
  /** SCRAPER_SKIP_REDUNDANT_SCORES=on (C-2); default off. */
  skipRedundantScores?: boolean;
  /** SCRAPER_CAP_AT_BEST_PRICE (rule O7); default the config's own default (off). */
  capAtBestPrice?: 'off' | 'on';
}

// --- documents -----------------------------------------------------------------

export interface OfMatch {
  date: string;
  time: string;
  team1: string;
  team2: string;
  score?: { ht?: [number, number]; ft: [number, number] };
}
export const ofDoc = (matches: OfMatch[]): string =>
  JSON.stringify({
    name: 'test league',
    matches: matches.map((m) => ({ round: 'Matchday 1', ...m })),
  });

export interface JsonEvent {
  id: number;
  league?: string;
  kick: string;
  h: string;
  a: string;
  st: 'NS' | 'FT' | 'PST';
  hs?: string | null;
  as?: string | null;
  hth?: string | null;
  hta?: string | null;
}
export const jsonDoc = (events: JsonEvent[]): string =>
  JSON.stringify({
    data: { events: events.map((e) => ({ league: 'Premier League', hs: null, as: null, ...e })) },
  });

export const ARSENAL_CHELSEA_OF: OfMatch = {
  date: '2026-11-02',
  time: '15:00',
  team1: 'Arsenal FC',
  team2: 'Chelsea FC',
};
export const ARSENAL_CHELSEA_JSON: JsonEvent = {
  id: 1,
  kick: '2026-11-02T15:00:00Z',
  h: 'Arsenal',
  a: 'Chelsea',
  st: 'NS',
};
/** A far-away fixture: parses fine, never creates an event (beyond the horizon). */
export const FAR_OF: OfMatch = {
  date: '2026-12-20',
  time: '15:00',
  team1: 'Liverpool FC',
  team2: 'Everton FC',
};
export const FAR_JSON: JsonEvent = {
  id: 2,
  kick: '2026-12-20T15:00:00Z',
  h: 'Liverpool',
  a: 'Everton',
  st: 'NS',
};

export const finishedOf = (ft: [number, number], ht: [number, number] = [0, 0]): OfMatch => ({
  ...ARSENAL_CHELSEA_OF,
  score: { ht, ft },
});
export const finishedJson = (ft: [number, number], ht: [number, number] = [0, 0]): JsonEvent => ({
  ...ARSENAL_CHELSEA_JSON,
  st: 'FT',
  hs: String(ft[0]),
  as: String(ft[1]),
  hth: String(ht[0]),
  hta: String(ht[1]),
});

// --- harness -------------------------------------------------------------------

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDatabase();
  await seedCatalog(db.db);
  const ids = await loadCatalogIds(db.db);
  const id = randomBytes(6).toString('hex');
  const redis = new Redis(REDIS_URL, { keyPrefix: `vamos-test:${id}:`, maxRetriesPerRequest: 2 });
  const dir = mkdtempSync(join(tmpdir(), 'vamos-scraper-test-'));
  const config = loadConfig({
    OPERATING_MODE: 'demo',
    LOG_LEVEL: 'silent',
    FEED_PROVIDER: 'scraped',
    SCRAPER_ARCHIVE_DIR: dir,
    SCRAPER_PORT: '0',
    ...(options.halfTimeMarkets === undefined
      ? {}
      : { SCRAPER_HALF_TIME_MARKETS: options.halfTimeMarkets }),
    ...(options.autoAlias === true ? { SCRAPER_AUTO_ALIAS: 'on' } : {}),
    ...(options.priorityCompetitions === undefined
      ? {}
      : { SCRAPER_PRIORITY_COMPETITIONS: options.priorityCompetitions }),
    ...(options.skipRedundantScores === true ? { SCRAPER_SKIP_REDUNDANT_SCORES: 'on' } : {}),
    ...(options.capAtBestPrice === undefined
      ? {}
      : { SCRAPER_CAP_AT_BEST_PRICE: options.capAtBestPrice }),
  });

  let clock = new Date(T0);
  const responses = new Map<string, Hit>();
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = new PoliteFetcher({
    userAgent: 'NahubetTest/1.0',
    robots: 'off',
    minIntervalMs: 0,
    jitterFraction: 0,
    maxAttempts: 1,
    now: () => clock.getTime(),
    sleep: () => Promise.resolve(),
    ...(options.secrets === undefined ? {} : { secrets: (name) => options.secrets?.[name] }),
    fetchImpl: (input, init) => {
      requests.push({ url: input, headers: { ...(init?.headers as Record<string, string>) } });
      const hit = responses.get(input) ?? { status: 404, body: 'not found' };
      // Like a real server: a conditional request for the page's current ETag gets a 304.
      const sent = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
      if (hit.status === 200 && hit.headers?.etag !== undefined && sent === hit.headers.etag) {
        return Promise.resolve(new Response(null, { status: 304 }));
      }
      return Promise.resolve(
        new Response(hit.body, {
          status: hit.status,
          headers: { 'content-type': 'application/json', ...hit.headers },
        }),
      );
    },
  });
  const ctx = createScraperContext({
    config,
    db: db.db,
    redis,
    logger: pino({ level: 'silent' }),
    clock: () => new Date(clock.getTime()),
    fetcher,
    archive: new FileRawArchive(dir, { now: () => new Date(clock.getTime()) }),
    channel: `vamos-test:${id}:live`,
  });

  const premier = ids.competitions.get('football/premier-league')!;
  const team = (shortName: string) => {
    const teamId = ids.teams.get(`football/${shortName}`);
    if (teamId === undefined) throw new Error(`no team ${shortName}`);
    return teamId;
  };
  const actor = { system: 'test' };
  await db.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: 'src-a',
        name: 'openfootball test',
        adapter: 'openfootball',
        upstream: 'openfootball',
        config: {
          allowedHosts: ['raw.githubusercontent.com'],
          requests: [{ url: URL_A, competition: 'Premier League' }],
          timeZone: 'Europe/London',
          sport: 'football',
        },
      },
      actor,
    );
    await upsertSource(
      tx,
      {
        id: 'src-b',
        name: 'json api test',
        adapter: 'generic-json',
        upstream: options.upstreamB ?? 'example-api',
        config: {
          allowedHosts: ['api.example.com'],
          requests: [{ url: URL_B, purpose: 'both' }],
          sport: 'football',
          recordsPath: 'data.events[*]',
          fields: {
            home: 'h',
            away: 'a',
            competition: { path: 'league' },
            kickoff: { path: 'kick', format: 'iso' },
            externalRef: 'id',
            status: { path: 'st', map: { FT: 'finished', NS: 'scheduled', PST: 'postponed' } },
            score: { homePath: 'hs', awayPath: 'as', htHomePath: 'hth', htAwayPath: 'hta' },
          },
          scoreBasis: 'regular_time',
        },
      },
      actor,
    );
    await setSourceEnabled(tx, 'src-a', true, actor);
    await setSourceEnabled(tx, 'src-b', true, actor);
    await setCompetitionPolicy(
      tx,
      premier,
      { enabled: true, autoResults: options.autoResults ?? true },
      actor,
    );
    if (options.calibrated !== false) {
      for (const name of ['Arsenal', 'Chelsea']) {
        await setTeamRatings(tx, team(name), { attack: 1.2, defence: 0.9, matches: 10 }, actor);
      }
    }
  });

  return {
    ctx,
    pool: db.pool,
    ids,
    premier,
    team,
    at: (date) => {
      clock = new Date(date.getTime());
    },
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    now: () => new Date(clock.getTime()),
    requests,
    serve: (url, hit) => {
      responses.set(url, typeof hit === 'string' ? { status: 200, body: hit } : hit);
    },
    source: async (sourceId) => (await getSource(db.db, sourceId))!,
    run: async (sourceId) =>
      runSource(ctx, (await getSource(db.db, sourceId))!, { trigger: 'manual' }),
    count: async (sql, params = []) => {
      const { rows } = await db.pool.query<{ n: string }>(sql, params);
      return Number(rows[0]?.n ?? 0);
    },
    close: async () => {
      await redis.quit();
      rmSync(dir, { recursive: true, force: true });
      await db.drop();
    },
  };
}

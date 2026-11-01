import { loadConfig } from '@vamos/config';
import {
  addCompetitionAlias,
  setEventBettingOpen,
  setSourceEnabled,
  upsertFixture,
  upsertSource,
} from '@vamos/db';
import {
  normalizeName,
  PoliteFetcher,
  therundownAffiliatesUrl,
  therundownDayUrl,
  therundownEventUrl,
  utcDateOf,
} from '@vamos/scraper';
import { pino } from 'pino';
import { createScraperContext, type ScraperContext } from '../src/context';
import { runTherundown, type TherundownSummary } from '../src/tasks/therundown';
import { affiliatesBody } from './therundown-bodies';
import { createHarness, type Harness, type Hit } from './helpers';

export const TR_SECRET = 'tr-k3y-9a7e1b6d0835-DO-NOT-LEAK';
export const TR_SOURCE = 'therundown';
export const TR_LABEL = 'TheRundown EPL';
const BASE = 'https://therundown.io';
const FILTERS = { marketIds: [1, 3], bookIds: [3, 32, 7, 9, 19] };

export interface Call {
  url: string;
  headers: Record<string, string>;
}

export interface TrHarnessOptions {
  /** The key reaches the fetcher (default true); false: SCRAPER_SECRET_THERUNDOWN is not set. */
  key?: boolean;
  /** What the config's competition label is (default: the one with an alias). */
  label?: string;
  oddsUse?: 'off' | 'reference' | 'publish';
  /** THERUNDOWN_LICENCE=operator (publish needs it). */
  operator?: boolean;
  /** The source row's enabled flag (default true). */
  enabled?: boolean;
  /** Replaces the source's config entirely. */
  config?: Record<string, unknown>;
}

export interface TrEventOptions {
  start?: Date;
  home?: string;
  away?: string;
  /** Home, draw, away (milli). */
  oneXTwo?: [number, number, number];
  /** Over, under (milli). */
  overUnder?: [number, number];
  feedRef?: string;
  /** Leave betting closed (the default is open). */
  closed?: boolean;
}

export interface TrHarness {
  h: Harness;
  ctx: ScraperContext;
  /** Every HTTP request the fetcher made, in order. */
  calls: Call[];
  /** Info and warn lines the scraper logged. */
  logs: string[];
  /** What the fake network answers for a URL (and for any URL nobody set: `fallback`). */
  answer(url: string, hit: Hit | string): void;
  fallback(hit: Hit): void;
  dayUrl(sportId: number, date: string): string;
  eventUrl(eventId: string): string;
  affiliatesUrl: string;
  /** The URL of the day request for a start time (TheRundown EPL, sport 11). */
  dayUrlOf(start: Date): string;
  tick(): Promise<TherundownSummary>;
  createEvent(options?: TrEventOptions): Promise<{
    eventId: string;
    feedRef: string;
    start: Date;
  }>;
  /** Rows of a query (parameters $1...). */
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  count(sql: string, params?: unknown[]): Promise<number>;
  event(
    eventId: string,
  ): Promise<{ betting_open: boolean; close_lead_ms: number; status: string; start_time: Date }>;
  close(): Promise<void>;
}

export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/** The harness of the catalogue and database, plus a TheRundown source on a fake network. */
export async function createTrHarness(options: TrHarnessOptions = {}): Promise<TrHarness> {
  const h = await createHarness();
  const logs: string[] = [];
  const logger = pino({ level: 'info' }, { write: (chunk: string) => void logs.push(chunk) });
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    FEED_PROVIDER: 'scraped',
    SCRAPER_ARCHIVE_DIR: h.ctx.config.scraper.archiveDir,
    SCRAPER_PORT: '0',
    THERUNDOWN_ENABLED: 'true',
    THERUNDOWN_ODDS_USE: options.oddsUse ?? 'reference',
    THERUNDOWN_LICENCE: options.operator === true ? 'operator' : 'internal',
  });

  const calls: Call[] = [];
  const answers = new Map<string, Hit>();
  let fallback: Hit = { status: 404, body: 'not found' };
  const affiliatesUrl = therundownAffiliatesUrl(BASE);
  answers.set(affiliatesUrl, { status: 200, body: affiliatesBody() });
  const fetcher = new PoliteFetcher({
    userAgent: 'VamosTest/1.0',
    robots: 'off',
    minIntervalMs: 0,
    jitterFraction: 0,
    maxAttempts: 1,
    now: () => h.now().getTime(),
    sleep: () => Promise.resolve(),
    secrets: (name) =>
      options.key === false || name !== 'SCRAPER_SECRET_THERUNDOWN' ? undefined : TR_SECRET,
    fetchImpl: (input, init) => {
      calls.push({ url: input, headers: { ...(init?.headers as Record<string, string>) } });
      const hit = answers.get(input) ?? fallback;
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
    db: h.ctx.db,
    redis: h.ctx.redis,
    logger,
    clock: () => h.now(),
    fetcher,
    archive: h.ctx.archive,
    channel: h.ctx.channel,
  });

  const actor = { system: 'test' };
  await ctx.db.transaction(async (tx) => {
    await upsertSource(
      tx,
      {
        id: TR_SOURCE,
        name: 'TheRundown (test)',
        adapter: 'therundown',
        upstream: 'TheRundown',
        config: options.config ?? {
          allowedHosts: ['therundown.io'],
          auth: { header: 'x-therundown-key', secret: 'SCRAPER_SECRET_THERUNDOWN' },
          competitions: [{ sportId: 11, competition: options.label ?? TR_LABEL }],
          markets: [1, 3],
          books: { anchors: [3, 32], others: [7, 9, 19] },
        },
      },
      actor,
    );
    if (options.enabled !== false) await setSourceEnabled(tx, TR_SOURCE, true, actor);
    // The other two sources of the harness are not part of these tests.
    await setSourceEnabled(tx, 'src-a', false, actor);
    await setSourceEnabled(tx, 'src-b', false, actor);
    await addCompetitionAlias(
      tx,
      {
        sportId: 'football',
        aliasNorm: normalizeName(TR_LABEL),
        sourceId: TR_SOURCE,
        competitionId: h.premier,
      },
      actor,
    );
  });

  let eventCounter = 0;
  return {
    h,
    ctx,
    calls,
    logs,
    answer: (url, hit) => {
      answers.set(url, typeof hit === 'string' ? { status: 200, body: hit } : hit);
    },
    fallback: (hit) => {
      fallback = hit;
    },
    dayUrl: (sportId, date) => therundownDayUrl(BASE, sportId, date, FILTERS),
    eventUrl: (eventId) => therundownEventUrl(BASE, eventId, FILTERS),
    affiliatesUrl,
    dayUrlOf: (start) => therundownDayUrl(BASE, 11, utcDateOf(start), FILTERS),
    tick: () => runTherundown(ctx),
    createEvent: async (opts = {}) => {
      eventCounter += 1;
      const start = opts.start ?? new Date(h.now().getTime() + 30 * HOUR);
      const home = h.team(opts.home ?? 'Arsenal');
      const away = h.team(opts.away ?? 'Chelsea');
      const feedRef =
        opts.feedRef ?? `fx|${h.premier}|${home}|${away}|${utcDateOf(start)}|${eventCounter}`;
      const [oneH, oneD, oneA] = opts.oneXTwo ?? [1850, 3900, 4000];
      const [over, under] = opts.overUnder ?? [1900, 1900];
      const eventId = await ctx.db.transaction(async (tx) => {
        const result = await upsertFixture(
          tx,
          {
            feedProvider: 'scraped',
            feedRef,
            sport: 'football',
            competitionId: h.premier,
            homeTeamId: home,
            awayTeamId: away,
            startTime: start,
          },
          [
            {
              type: '1x2',
              line: null,
              selections: [
                { code: '1', oddsMilli: oneH },
                { code: 'X', oddsMilli: oneD },
                { code: '2', oddsMilli: oneA },
              ],
            },
            {
              type: 'ou',
              line: '2.5',
              selections: [
                { code: 'over', oddsMilli: over },
                { code: 'under', oddsMilli: under },
              ],
            },
          ],
          { now: h.now() },
        );
        await setEventBettingOpen(tx, result.eventId, opts.closed !== true);
        return result.eventId;
      });
      return { eventId, feedRef, start };
    },
    rows: async <T>(sql: string, params: unknown[] = []) =>
      (await h.pool.query<T>(sql, params)).rows,
    count: (sql, params) => h.count(sql, params),
    event: async (eventId) => {
      const { rows } = await h.pool.query<{
        betting_open: boolean;
        close_lead_ms: number;
        status: string;
        start_time: Date;
      }>(`SELECT betting_open, close_lead_ms, status, start_time FROM events WHERE id = $1`, [
        eventId,
      ]);
      return rows[0]!;
    },
    close: () => h.close(),
  };
}

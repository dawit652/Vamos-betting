import { scraperUserAgent, type AppConfig } from '@vamos/config';
import { LIVE_CHANNEL, type Database } from '@vamos/db';
import { FileRawArchive, PoliteFetcher, type RawArchive } from '@vamos/scraper';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** What every part of the scraper needs from the outside world (tests pass their own). */
export interface ScraperContext {
  config: AppConfig;
  db: Database;
  redis: Redis;
  logger: Logger;
  /** Current time. The scraper reads the time only from here. */
  clock: () => Date;
  /** One shared fetcher: its per-host rate limit and circuit breakers span all sources. */
  fetcher: PoliteFetcher;
  /** The raw snapshot store. */
  archive: RawArchive;
  /** Redis channel for live deltas (LIVE_CHANNEL; tests use a unique one). */
  channel: string;
}

export interface ScraperContextInput {
  config: AppConfig;
  db: Database;
  redis: Redis;
  logger: Logger;
  clock?: () => Date;
  fetcher?: PoliteFetcher;
  archive?: RawArchive;
  channel?: string;
}

/** The context for main and for tests: anything not given is built from the config. */
export function createScraperContext(input: ScraperContextInput): ScraperContext {
  const clock = input.clock ?? (() => new Date());
  const { config } = input;
  return {
    config,
    db: input.db,
    redis: input.redis,
    logger: input.logger,
    clock,
    fetcher:
      input.fetcher ??
      new PoliteFetcher({
        userAgent: scraperUserAgent(config.scraper),
        robots: config.scraper.robots,
        maxConcurrency: config.scraper.maxConcurrency,
      }),
    archive: input.archive ?? new FileRawArchive(config.scraper.archiveDir, { now: clock }),
    channel: input.channel ?? LIVE_CHANNEL,
  };
}

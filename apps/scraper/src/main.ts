import {
  baseLoggerOptions,
  ConfigError,
  gracefulShutdown,
  installLastResortHandlers,
  loadConfig,
  loadDotEnv,
  type AppConfig,
} from '@vamos/config';
import { claimOperatingMode, createDb, OperatingModeMismatchError } from '@vamos/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createScraperContext } from './context';
import { startHealthServer, scraperReadinessChecks, type HealthServer } from './lib/health';
import type { ScraperTask } from './lib/interval';
import { createTasks } from './tasks/index';

/** Longest clean shutdown before the process exits anyway (exit code 1). */
const SHUTDOWN_TIMEOUT_MS = 60_000;

function refuseToStart(message: string): never {
  console.error(`[vamos-scraper] refusing to start.\n${message}`);
  process.exit(1);
}

/** Starts the tasks in order; if one fails the started ones are stopped again. */
async function startTasks(tasks: ScraperTask[]): Promise<() => Promise<void>> {
  const started: ScraperTask[] = [];
  try {
    for (const task of tasks) {
      await task.start();
      started.push(task);
    }
  } catch (error) {
    await Promise.allSettled(started.reverse().map((task) => task.stop()));
    throw error;
  }
  return async () => {
    for (const task of [...started].reverse()) await task.stop();
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) refuseToStart(error.message);
    throw error;
  }
  if (config.feed.provider !== 'scraped') {
    refuseToStart(
      `The scraper only runs with FEED_PROVIDER=scraped (it is "${config.feed.provider}"). ` +
        'Set FEED_PROVIDER=scraped, or do not start this process.',
    );
  }

  const logger = pino(baseLoggerOptions({ level: config.logLevel, service: 'vamos-scraper' }));
  const handle = createDb(config.databaseUrl, { max: 10 });
  try {
    // A demo database (play money) must never serve licensed mode, nor the reverse.
    await claimOperatingMode(handle.db, config.mode);
  } catch (error) {
    await handle.close();
    if (error instanceof OperatingModeMismatchError) refuseToStart(error.message);
    refuseToStart(
      `could not check the database's operating mode (has "pnpm db:migrate" run?): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (config.mode === 'demo') logger.warn('running in DEMO mode: play money only');

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  redis.on('error', (error: unknown) => logger.warn({ err: error }, 'redis connection error'));
  const closeConnections = async () => {
    await Promise.allSettled([redis.quit(), handle.close()]);
  };

  const ctx = createScraperContext({ config, db: handle.db, redis, logger });
  const tasks = createTasks(ctx);

  let health: HealthServer | null = null;
  if (config.scraper.port > 0) {
    try {
      health = await startHealthServer({
        port: config.scraper.port,
        checks: scraperReadinessChecks({ db: handle.db, redis }),
        logger,
      });
      logger.info({ port: health.port }, 'health server listening (/health, /ready)');
    } catch (error) {
      logger.error(
        { err: error, port: config.scraper.port },
        'could not start the health server (port in use?)',
      );
    }
  }

  let stopTasks: (() => Promise<void>) | null = null;
  let starting: Promise<unknown> = Promise.resolve();
  const keepAlive = setInterval(() => undefined, 60_000);
  const shutdown = gracefulShutdown({
    logger,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    steps: [
      {
        name: 'stop taking work',
        run: async () => {
          health?.markDraining();
          clearInterval(keepAlive);
          await starting.catch(() => undefined);
          await stopTasks?.();
        },
      },
      { name: 'health server', run: async () => health?.close() },
      { name: 'database and redis', run: closeConnections },
    ],
  });
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  installLastResortHandlers({ logger, shutdown });

  try {
    logger.info({ mode: config.mode, tasks: tasks.map((t) => t.name) }, 'starting scraper');
    const started = startTasks(tasks);
    starting = started;
    stopTasks = await started;
  } catch (error) {
    logger.error({ err: error }, 'failed to start');
    clearInterval(keepAlive);
    await health?.close();
    await closeConnections();
    process.exit(1);
  }
}

await main();

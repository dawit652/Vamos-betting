import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from '@vamos/config';
import { claimOperatingMode, createDb, LIVE_CHANNEL, OperatingModeMismatchError } from '@vamos/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createTasks } from './tasks/index';
import { startWorker, type WorkerHandle } from './worker';

function refuseToStart(message: string): never {
  console.error(`[vamos-worker] refusing to start.\n${message}`);
  process.exit(1);
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

  const logger = pino({ level: config.logLevel, base: { service: 'vamos-worker' } });
  const handle = createDb(config.databaseUrl, { max: 10 });

  // A demo database (play money) must never serve licensed mode, nor the reverse.
  try {
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
  if (config.mode === 'demo') {
    logger.warn('running in DEMO mode: play money only, simulated odds and matches');
  }

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  redis.on('error', (error: unknown) => logger.warn({ err: error }, 'redis connection error'));
  const closeConnections = async () => {
    await Promise.allSettled([redis.quit(), handle.close()]);
  };

  const tasks = createTasks(config, {
    db: handle.db,
    redis,
    logger,
    clock: () => new Date(),
    channel: LIVE_CHANNEL,
  });
  let worker: WorkerHandle;
  try {
    worker = await startWorker(config, logger, tasks);
  } catch (error) {
    logger.error({ err: error }, 'failed to start');
    await closeConnections();
    process.exit(1);
  }

  // Keep the process alive while tasks run on their own timers/queues.
  const keepAlive = setInterval(() => undefined, 60_000);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
    try {
      await worker.stop();
    } finally {
      await closeConnections();
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();

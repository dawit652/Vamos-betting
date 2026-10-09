import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from '@vamos/config';
import {
  claimOperatingMode,
  createDb,
  getDatabaseInstallationId,
  LIVE_CHANNEL,
  OperatingModeMismatchError,
} from '@vamos/db';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { bindQueuePrefix, QueuePrefixBoundError, withTimeout } from './lib/queues';
import { createTasks } from './tasks/index';
import { startWorker, type WorkerHandle } from './worker';

/** Longest clean shutdown before the process exits anyway (exit code 1). */
const SHUTDOWN_TIMEOUT_MS = 60_000;

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

  // The queues must hold this database's jobs only (see bindQueuePrefix).
  try {
    const installationId = await getDatabaseInstallationId(handle.db);
    if (installationId === null) throw new Error('the database has no installation id');
    await withTimeout(
      bindQueuePrefix(redis, config.queuePrefix, installationId),
      5000,
      'queue prefix check',
    );
  } catch (error) {
    if (error instanceof QueuePrefixBoundError) {
      await closeConnections();
      refuseToStart(error.message);
    }
    // Redis down at startup: the tasks wait for it anyway; the check is best effort.
    logger.warn({ err: error }, 'could not check the queue prefix binding (redis unreachable?)');
  }

  const tasks = createTasks(config, {
    db: handle.db,
    redis,
    logger,
    clock: () => new Date(),
    channel: LIVE_CHANNEL,
    queues: { redisUrl: config.redisUrl, prefix: config.queuePrefix },
  });
  // Signal handlers go in before the tasks start, so a SIGTERM during startup
  // still shuts down cleanly (after the start finished) instead of killing
  // the process mid-way.
  let worker: WorkerHandle | null = null;
  let starting: Promise<unknown> = Promise.resolve();
  // Keep the process alive while tasks run on their own timers/queues.
  const keepAlive = setInterval(() => undefined, 60_000);
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
    // A stop that hangs (e.g. on an unreachable Redis) must not keep the process up.
    setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await starting.catch(() => undefined);
      await worker?.stop();
    } finally {
      await closeConnections();
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const started = startWorker(config, logger, tasks);
    starting = started;
    worker = await started;
  } catch (error) {
    logger.error({ err: error }, 'failed to start');
    clearInterval(keepAlive);
    await closeConnections();
    process.exit(1);
  }
}

await main();

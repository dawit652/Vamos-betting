import { randomBytes } from 'node:crypto';
import {
  baseLoggerOptions,
  ConfigError,
  gracefulShutdown,
  installLastResortHandlers,
  loadConfig,
  loadDotEnv,
  startTelemetry,
  type AppConfig,
} from '@vamos/config';
import {
  claimOperatingMode,
  createDb,
  getDatabaseInstallationId,
  LIVE_CHANNEL,
  OperatingModeMismatchError,
} from '@vamos/db';
import { createPaymentProviders, PaymentProviderError } from '@vamos/payments';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { startHealthServer, workerReadinessChecks, type HealthServer } from './lib/health';
import {
  bindQueuePrefix,
  QueuePrefixBoundError,
  setQueueTelemetry,
  withTimeout,
} from './lib/queues';
import { createSmsSender, SmsProviderNotImplementedError } from './lib/sms';
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

  // Structured JSON logs with secrets redacted (the same rules as the API).
  const logger = pino(baseLoggerOptions({ level: config.logLevel, service: 'vamos-worker' }));

  // Payment providers (only the mock one in demo mode): one that is not
  // configured must not run, like in the API.
  let payments;
  try {
    payments = createPaymentProviders(config, {
      fetch: globalThis.fetch,
      clock: () => new Date(),
      randomBytes: (size) => randomBytes(size),
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) refuseToStart(`payments: ${error.message}`);
    throw error;
  }

  const handle = createDb(config.databaseUrl, { max: 10 });
  let sms;
  try {
    sms = createSmsSender(config.providers.sms, handle.db);
  } catch (error) {
    await handle.close();
    if (error instanceof SmsProviderNotImplementedError) refuseToStart(error.message);
    throw error;
  }

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

  const tasks = createTasks(
    config,
    {
      db: handle.db,
      redis,
      logger,
      clock: () => new Date(),
      channel: LIVE_CHANNEL,
      queues: { redisUrl: config.redisUrl, prefix: config.queuePrefix },
      payments,
      sms,
      demo: config.mode === 'demo',
    },
    {
      // FEED_ROLLING_* (e2e runs with a fixture every minute); the competitions
      // stay the feed's default (the featured ones).
      feedIngest: { rolling: config.feed.rolling },
    },
  );
  // OpenTelemetry only when OTEL_EXPORTER_OTLP_ENDPOINT is set: a consumer span per job.
  const telemetry = await startTelemetry(config, 'vamos-worker');
  setQueueTelemetry(telemetry);
  if (telemetry.enabled) logger.info('tracing on (OpenTelemetry, OTLP over HTTP)');

  // GET /health and /ready for the orchestrator (WORKER_HEALTH_PORT; 0 = off). A port in use is
  // logged, not fatal: the worker's jobs matter more than its probe.
  let health: HealthServer | null = null;
  if (config.worker.healthPort > 0) {
    try {
      health = await startHealthServer({
        host: config.worker.healthHost,
        port: config.worker.healthPort,
        checks: workerReadinessChecks({ db: handle.db, redis }),
        logger,
      });
      logger.info({ port: health.port }, 'health server listening (/health, /ready)');
    } catch (error) {
      logger.error(
        { err: error, port: config.worker.healthPort },
        'could not start the health server (port in use?)',
      );
    }
  }

  // Signal handlers go in before the tasks start, so a SIGTERM during startup
  // still shuts down cleanly (after the start finished) instead of killing
  // the process mid-way.
  let worker: WorkerHandle | null = null;
  let starting: Promise<unknown> = Promise.resolve();
  // Keep the process alive while tasks run on their own timers/queues.
  const keepAlive = setInterval(() => undefined, 60_000);
  // SIGTERM: /ready answers 503 at once, the tasks stop taking work and finish the jobs in
  // hand (BullMQ close waits for active jobs; interval tasks finish their run), then the
  // health server, Redis and the database pool close and the last spans are flushed.
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
          await worker?.stop();
        },
      },
      { name: 'health server', run: async () => health?.close() },
      { name: 'database and redis', run: closeConnections },
      { name: 'telemetry', run: () => telemetry.shutdown() },
    ],
  });
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  installLastResortHandlers({ logger, shutdown });

  try {
    const started = startWorker(config, logger, tasks);
    starting = started;
    worker = await started;
  } catch (error) {
    logger.error({ err: error }, 'failed to start');
    clearInterval(keepAlive);
    await health?.close();
    await closeConnections();
    process.exit(1);
  }
}

await main();

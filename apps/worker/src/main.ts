import { ConfigError, loadConfig, loadDotEnv } from '@vamos/config';
import { pino } from 'pino';
import { startWorker } from './worker';

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[vamos-worker] refusing to start.\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const logger = pino({ level: config.logLevel, base: { service: 'vamos-worker' } });
  const handle = await startWorker(config, logger);

  // Keep the process alive while tasks run on their own timers/queues.
  const keepAlive = setInterval(() => undefined, 60_000);
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    clearInterval(keepAlive);
    await handle.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();

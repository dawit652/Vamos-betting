import { ConfigError, loadConfig, loadDotEnv } from '@vamos/config';
import { buildApp } from './app';

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[vamos-api] refusing to start.\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const app = buildApp({ config });
  if (config.mode === 'demo') {
    app.log.warn('running in DEMO mode: play money only, mock providers, no real payments');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.api.host, port: config.api.port });
}

await main();

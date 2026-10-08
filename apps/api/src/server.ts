import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from '@vamos/config';
import { buildApp } from './app';
import { createDefaultDeps, ProviderNotImplementedError, type DefaultDeps } from './deps';

function refuseToStart(message: string): never {
  console.error(`[vamos-api] refusing to start.\n${message}`);
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

  let deps: DefaultDeps;
  try {
    deps = createDefaultDeps(config);
  } catch (error) {
    if (error instanceof ProviderNotImplementedError) refuseToStart(error.message);
    throw error;
  }

  const app = buildApp(deps);
  if (config.mode === 'demo') {
    app.log.warn('running in DEMO mode: play money only, mock providers, no real payments');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      await deps.close();
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.api.host, port: config.api.port });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start');
    await app.close();
    await deps.close();
    process.exit(1);
  }
}

await main();

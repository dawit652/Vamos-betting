import { ConfigError, loadConfig, loadDotEnv, type AppConfig } from '@vamos/config';
import { claimOperatingMode, OperatingModeMismatchError } from '@vamos/db';
import { buildApp } from './app';
import { createDefaultDeps, ProviderNotImplementedError, type DefaultDeps } from './deps';
import {
  apiConfigProblems,
  parseTrustProxy,
  StartupError,
  type TrustProxySetting,
} from './startup';

function refuseToStart(message: string): never {
  console.error(`[vamos-api] refusing to start.\n${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  loadDotEnv();
  let config: AppConfig;
  let trustProxy: TrustProxySetting;
  try {
    config = loadConfig();
    // TRUST_PROXY is read here until it moves into @vamos/config.
    trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof StartupError) {
      refuseToStart(error.message);
    }
    throw error;
  }
  const problems = apiConfigProblems(config);
  if (problems.length > 0) {
    refuseToStart(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }

  let deps: DefaultDeps;
  try {
    deps = createDefaultDeps(config);
  } catch (error) {
    if (error instanceof ProviderNotImplementedError) refuseToStart(error.message);
    throw error;
  }

  // A demo database (play money) must never serve licensed mode, nor the reverse.
  try {
    await claimOperatingMode(deps.db, config.mode);
  } catch (error) {
    await deps.close();
    if (error instanceof OperatingModeMismatchError) refuseToStart(error.message);
    refuseToStart(
      `could not check the database's operating mode (has "pnpm db:migrate" run?): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const app = buildApp(deps, { trustProxy });
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

import {
  ConfigError,
  installLastResortHandlers,
  loadConfig,
  loadDotEnv,
  startTelemetry,
  type AppConfig,
} from '@vamos/config';
import { claimOperatingMode, OperatingModeMismatchError, syncRailAccounts } from '@vamos/db';
import { PaymentProviderError, SmsRailProvider } from '@vamos/payments';
import { buildApp } from './app';
import { createDefaultDeps, ProviderNotImplementedError, type DefaultDeps } from './deps';
import { createApiShutdown } from './lib/shutdown';
import { apiConfigProblems } from './startup';

/** How often the API reloads the collection accounts from the database. */
const COLLECTION_ACCOUNT_SYNC_MS = 15_000;

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
  const problems = apiConfigProblems(config);
  if (problems.length > 0) {
    refuseToStart(`Invalid configuration:\n - ${problems.join('\n - ')}`);
  }

  let deps: DefaultDeps;
  try {
    deps = createDefaultDeps(config);
  } catch (error) {
    if (error instanceof ProviderNotImplementedError) refuseToStart(error.message);
    // A payment provider without credentials (or a skeleton) must not run.
    if (error instanceof PaymentProviderError) refuseToStart(`payments: ${error.message}`);
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

  // OpenTelemetry only when OTEL_EXPORTER_OTLP_ENDPOINT is set (no-op, nothing loaded, otherwise).
  const telemetry = await startTelemetry(config, 'vamos-api');
  const app = buildApp(deps, { telemetry });
  if (config.mode === 'demo') {
    app.log.warn('running in DEMO mode: play money only, mock providers, no real payments');
  }
  const sms = config.payments.sms;
  if (config.mode === 'licensed' && !sms.requirePayoutProof && sms.payoutProofWaived) {
    app.log.warn(
      'PAYOUT_PROOF_WAIVED: manual payouts can be settled without their debit SMS as proof',
    );
  }
  if (telemetry.enabled) app.log.info('tracing on (OpenTelemetry, OTLP over HTTP)');

  // The SMS rail's collection accounts are managed in the back office: load them before taking
  // requests, then every few seconds (another API process may have changed them).
  const rail = deps.payments.get('sms');
  if (rail instanceof SmsRailProvider) {
    const sync = () => syncRailAccounts(deps.db, rail, deps.clock());
    try {
      await sync();
    } catch (error) {
      app.log.error(
        { err: error },
        'could not load the collection accounts: SMS_COLLECTION_ACCOUNTS is used until the next try',
      );
    }
    const timer = setInterval(() => {
      sync().catch((error: unknown) =>
        app.log.warn({ err: error }, 'collection accounts: reload failed'),
      );
    }, COLLECTION_ACCOUNT_SYNC_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  const shutdown = createApiShutdown({
    app,
    closeDeps: () => deps.close(),
    telemetry,
    exit: (code) => process.exit(code),
  });
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  installLastResortHandlers({ logger: app.log, shutdown });

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

import { gracefulShutdown, type Telemetry } from '@vamos/config';
import type { FastifyInstance } from 'fastify';

/** Longest clean shutdown (drain requests, close pools) before the process exits anyway. */
export const API_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * The API's SIGTERM / SIGINT handler: stop accepting connections and wait
 * for the requests in flight (app.close: requests arriving meanwhile get
 * 503, SSE streams end, after-response work finishes), then close the
 * database pool and Redis (`closeDeps`), then flush the last spans, then exit.
 */
export function createApiShutdown(input: {
  app: FastifyInstance;
  closeDeps: () => Promise<void>;
  telemetry: Telemetry;
  exit: (code: number) => void;
  timeoutMs?: number;
}): (signal: string, crashed?: boolean) => Promise<void> {
  return gracefulShutdown({
    logger: input.app.log,
    timeoutMs: input.timeoutMs ?? API_SHUTDOWN_TIMEOUT_MS,
    exit: input.exit,
    steps: [
      { name: 'http server', run: () => input.app.close() },
      { name: 'database and redis', run: input.closeDeps },
      { name: 'telemetry', run: () => input.telemetry.shutdown() },
    ],
  });
}

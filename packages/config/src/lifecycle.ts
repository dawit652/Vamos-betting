/** A step of a graceful shutdown (stop accepting work, drain, close pools…). */
export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

export interface ShutdownLogger {
  info(object: object, message: string): void;
  error(object: object, message: string): void;
}

export interface GracefulShutdownOptions {
  logger: ShutdownLogger;
  /** Run in order; a failing step is logged and the next one still runs. */
  steps: ShutdownStep[];
  /** Longest clean shutdown before exiting with code 1 anyway. */
  timeoutMs: number;
  /** process.exit in production; a spy in tests. */
  exit: (code: number) => void;
}

/**
 * A SIGTERM / SIGINT handler: runs the steps once, in order, then exits with
 * 0 (1 when a step failed or the whole shutdown outlived `timeoutMs`, e.g. a
 * pool waiting on an unreachable server). Later signals are ignored while it
 * runs. Resolves when the steps are done (tests await it).
 */
export function gracefulShutdown(
  options: GracefulShutdownOptions,
): (signal: string) => Promise<void> {
  let running: Promise<void> | null = null;
  return (signal) => {
    if (running !== null) return running;
    running = (async () => {
      options.logger.info({ signal }, 'shutting down');
      const timer = setTimeout(() => {
        options.logger.error({ timeoutMs: options.timeoutMs }, 'shutdown timed out; exiting');
        options.exit(1);
      }, options.timeoutMs);
      timer.unref();
      let failed = false;
      for (const step of options.steps) {
        try {
          await step.run();
        } catch (error) {
          failed = true;
          options.logger.error({ err: error, step: step.name }, 'shutdown step failed');
        }
      }
      clearTimeout(timer);
      options.logger.info({ signal, failed }, 'shut down');
      options.exit(failed ? 1 : 0);
    })();
    return running;
  };
}
